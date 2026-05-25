/**
 * @fileoverview Main entry point for Reddit Sentinel AI — Devvit app.
 *
 * Registers all triggers, scheduler jobs, menu items, and the
 * custom post type (Sentinel Dashboard). Wires the classifier,
 * rule engine, scheduler, and analytics services into Devvit's
 * event system.
 *
 * Architecture:
 *   PostCreate/CommentCreate → classifier → rule engine → Redis queue
 *   Scheduler (every 5 min) → spike detection + health score
 *   Menu items → manual analysis + dashboard creation
 *   Custom post → webview dashboard (webroot/index.html)
 */

import { Devvit, useState, useWebView } from '@devvit/public-api';
import type {
  SentinelItem,
  AuditLogEntry,
  WebviewToDevvitMessage,
  DevvitToWebviewMessage,
  DashboardTab,
  ActionStatus,
  AnalyticsPeriod,
} from './types/index.js';

// Services
import { classifyWithContext, scoreToTier } from './services/classifier.js';
import { evaluateRules, executeKVAction } from './services/ruleEngine.js';
import { runScheduledIntelligence, formatSpikeAlert } from './services/scheduler.js';
import { computeAnalytics } from './services/analytics.js';
import { generateDraft } from './services/modmail.js';

// Storage
import {
  addToQueue,
  updateItemStatus,
  getQueue,
  recordActivity,
  incrementHourlyVolume,
  incrementDailyVolume,
  recordRemoval,
  recordResponseTime,
} from './storage/redisStore.js';
import {
  addAuditEntry,
  getAuditLog,
  getRules,
  getWatchlist,
  saveRule,
  deleteRule,
  toggleRule,
  addToWatchlist,
  removeFromWatchlist,
  isOnWatchlist,
  recordRemovedAuthor,
  incrementCounter,
} from './storage/kvStore.js';

// ─────────────────────────────────────────────
// App Configuration
// ─────────────────────────────────────────────

Devvit.configure({
  redditAPI: true,
  kvStore: true,
  redis: true,
});

// ─────────────────────────────────────────────
// Rate Limiting (prevent duplicate analysis)
// ─────────────────────────────────────────────

/** Track recently analyzed items to avoid double-processing. */
const recentlyAnalyzed = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

/**
 * Check if an item was recently analyzed (within RATE_LIMIT_MS).
 */
function isRateLimited(itemId: string): boolean {
  const lastAnalyzed = recentlyAnalyzed.get(itemId);
  if (lastAnalyzed && Date.now() - lastAnalyzed < RATE_LIMIT_MS) return true;
  recentlyAnalyzed.set(itemId, Date.now());
  // Cleanup old entries periodically
  if (recentlyAnalyzed.size > 1000) {
    const now = Date.now();
    for (const [key, time] of recentlyAnalyzed) {
      if (now - time > RATE_LIMIT_MS) recentlyAnalyzed.delete(key);
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Trigger: PostCreate
// ─────────────────────────────────────────────

Devvit.addTrigger({
  event: 'PostCreate',
  onEvent: async (event, context) => {
    try {
      const post = event.post;
      if (!post || !post.id) return;

      const subreddit = event.subreddit?.name || '';
      if (!subreddit) return;

      // Rate limit check
      if (isRateLimited(post.id)) return;

      // Get author info
      let accountAgeDays = 365;
      let postKarma = 1000;
      let commentKarma = 1000;
      let authorName = event.author?.name || '[deleted]';

      try {
        if (authorName && authorName !== '[deleted]') {
          const author = await context.reddit.getUserByUsername(authorName);
          if (author) {
            const createdAt = author.createdAt?.getTime?.() || Date.now();
            accountAgeDays = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
            postKarma = author.linkKarma ?? 0;
            commentKarma = author.commentKarma ?? 0;
          }
        }
      } catch {
        // If we can't get author info, use defaults (conservative)
      }

      const content = `${post.title || ''} ${post.selftext || ''}`.trim();
      if (!content) return;

      // Record activity
      await recordActivity(context.redis, subreddit, authorName, 'post');
      await incrementHourlyVolume(context.redis, subreddit);
      await incrementDailyVolume(context.redis, subreddit);

      // Run classifier
      const result = await classifyWithContext(
        context.redis,
        context.kvStore,
        subreddit,
        content,
        'post',
        authorName,
        accountAgeDays,
        postKarma,
        commentKarma
      );

      // Only process if not CLEAN
      if (result.riskTier === 'CLEAN') return;

      // Create SentinelItem
      const item: SentinelItem = {
        id: post.id,
        type: 'post',
        contentPreview: content.substring(0, 280),
        authorName,
        authorKarma: postKarma + commentKarma,
        authorAccountAgeDays: accountAgeDays,
        subreddit,
        createdAt: Date.now(),
        flaggedAt: Date.now(),
        riskTier: result.riskTier,
        riskScore: result.riskScore,
        signalBreakdown: result.signalBreakdown,
        matchedSignals: result.matchedSignals,
        status: 'pending',
        permalink: post.permalink || `/r/${subreddit}/comments/${post.id.replace('t3_', '')}`,
      };

      // CRITICAL: Auto-remove and send modmail alert
      if (result.riskTier === 'CRITICAL') {
        try {
          await context.reddit.remove(post.id, false);
          item.status = 'removed';
          item.reviewedBy = 'sentinel';
          item.reviewedAt = Date.now();

          await recordRemoval(context.redis, subreddit, authorName);
          await recordRemovedAuthor(context.kvStore, subreddit, authorName);

          // Log auto-remove
          await addAuditEntry(context.kvStore, subreddit, {
            id: `audit_${Date.now()}_${post.id}`,
            timestamp: Date.now(),
            actionType: 'auto_remove',
            targetId: post.id,
            targetUser: authorName,
            actor: 'sentinel',
            details: result.matchedSignals.join(' | '),
            riskTier: 'CRITICAL',
          });

          await incrementCounter(context.kvStore, subreddit, 'auto_actioned', new Date().toISOString().slice(0, 10));
        } catch {
          // If we can't remove (permissions), still flag it
          item.status = 'pending';
        }
      }

      // Add to queue
      await addToQueue(context.redis, subreddit, item);

      // Log flagging
      if (result.riskTier !== 'CRITICAL') {
        await addAuditEntry(context.kvStore, subreddit, {
          id: `audit_${Date.now()}_${post.id}`,
          timestamp: Date.now(),
          actionType: 'auto_flag',
          targetId: post.id,
          targetUser: authorName,
          actor: 'sentinel',
          details: result.matchedSignals.join(' | '),
          riskTier: result.riskTier,
        });
      }

      await incrementCounter(context.kvStore, subreddit, 'total_flagged', new Date().toISOString().slice(0, 10));

      // Run custom rules
      try {
        const ruleActions = await evaluateRules(context.kvStore, subreddit, item);
        for (const actionReq of ruleActions) {
          const result = await executeKVAction(context.kvStore, subreddit, actionReq);
          if (result.requiresRedditAPI) {
            await executeRedditAction(context, post.id, result.apiAction!, result.payload, subreddit, authorName);
          }
        }
      } catch {
        // Rule engine errors shouldn't break the main pipeline
      }
    } catch (error) {
      console.error('Sentinel: Error processing PostCreate:', error);
    }
  },
});

// ─────────────────────────────────────────────
// Trigger: CommentCreate
// ─────────────────────────────────────────────

Devvit.addTrigger({
  event: 'CommentCreate',
  onEvent: async (event, context) => {
    try {
      const comment = event.comment;
      if (!comment || !comment.id) return;

      const subreddit = event.subreddit?.name || '';
      if (!subreddit) return;

      if (isRateLimited(comment.id)) return;

      let accountAgeDays = 365;
      let postKarma = 1000;
      let commentKarma = 1000;
      let authorName = comment.author || '[deleted]';

      try {
        if (authorName && authorName !== '[deleted]') {
          const author = await context.reddit.getUserByUsername(authorName);
          if (author) {
            const createdAt = author.createdAt?.getTime?.() || Date.now();
            accountAgeDays = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
            postKarma = author.linkKarma ?? 0;
            commentKarma = author.commentKarma ?? 0;
          }
        }
      } catch {
        // Use defaults
      }

      const content = comment.body || '';
      if (!content.trim()) return;

      await recordActivity(context.redis, subreddit, authorName, 'comment');
      await incrementHourlyVolume(context.redis, subreddit);
      await incrementDailyVolume(context.redis, subreddit);

      const result = await classifyWithContext(
        context.redis,
        context.kvStore,
        subreddit,
        content,
        'comment',
        authorName,
        accountAgeDays,
        postKarma,
        commentKarma
      );

      if (result.riskTier === 'CLEAN') return;

      const item: SentinelItem = {
        id: comment.id,
        type: 'comment',
        contentPreview: content.substring(0, 280),
        authorName,
        authorKarma: postKarma + commentKarma,
        authorAccountAgeDays: accountAgeDays,
        subreddit,
        createdAt: Date.now(),
        flaggedAt: Date.now(),
        riskTier: result.riskTier,
        riskScore: result.riskScore,
        signalBreakdown: result.signalBreakdown,
        matchedSignals: result.matchedSignals,
        status: 'pending',
      };

      if (result.riskTier === 'CRITICAL') {
        try {
          await context.reddit.remove(comment.id, false);
          item.status = 'removed';
          item.reviewedBy = 'sentinel';
          item.reviewedAt = Date.now();

          await recordRemoval(context.redis, subreddit, authorName);
          await recordRemovedAuthor(context.kvStore, subreddit, authorName);

          await addAuditEntry(context.kvStore, subreddit, {
            id: `audit_${Date.now()}_${comment.id}`,
            timestamp: Date.now(),
            actionType: 'auto_remove',
            targetId: comment.id,
            targetUser: authorName,
            actor: 'sentinel',
            details: result.matchedSignals.join(' | '),
            riskTier: 'CRITICAL',
          });

          await incrementCounter(context.kvStore, subreddit, 'auto_actioned', new Date().toISOString().slice(0, 10));
        } catch {
          item.status = 'pending';
        }
      }

      await addToQueue(context.redis, subreddit, item);

      if (result.riskTier !== 'CRITICAL') {
        await addAuditEntry(context.kvStore, subreddit, {
          id: `audit_${Date.now()}_${comment.id}`,
          timestamp: Date.now(),
          actionType: 'auto_flag',
          targetId: comment.id,
          targetUser: authorName,
          actor: 'sentinel',
          details: result.matchedSignals.join(' | '),
          riskTier: result.riskTier,
        });
      }

      await incrementCounter(context.kvStore, subreddit, 'total_flagged', new Date().toISOString().slice(0, 10));

      // Run custom rules
      try {
        const ruleActions = await evaluateRules(context.kvStore, subreddit, item);
        for (const actionReq of ruleActions) {
          const res = await executeKVAction(context.kvStore, subreddit, actionReq);
          if (res.requiresRedditAPI) {
            await executeRedditAction(context, comment.id, res.apiAction!, res.payload, subreddit, authorName);
          }
        }
      } catch {
        // Swallow rule engine errors
      }
    } catch (error) {
      console.error('Sentinel: Error processing CommentCreate:', error);
    }
  },
});

// ─────────────────────────────────────────────
// Trigger: ModAction (track mod overrides)
// ─────────────────────────────────────────────

Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    try {
      const action = event.action;
      const subreddit = event.subreddit?.name || '';
      if (!subreddit || !action) return;

      const targetId = event.targetPost?.id || event.targetComment?.id;
      if (!targetId) return;

      const moderator = event.moderator?.name || 'unknown';

      // Check if this item was in our queue
      const item = await import('./storage/redisStore.js').then(m =>
        m.getItem(context.redis, subreddit, targetId)
      );

      if (item && item.status === 'pending') {
        // A mod took action on a Sentinel-flagged item outside the dashboard
        const isApprove = action === 'approvelink' || action === 'approvecomment';
        const isRemove = action === 'removelink' || action === 'removecomment';

        if (isApprove || isRemove) {
          const newStatus: ActionStatus = isApprove ? 'approved' : 'removed';
          const isOverride = isApprove && (item.riskTier === 'CRITICAL' || item.riskTier === 'HIGH');

          await updateItemStatus(
            context.redis,
            subreddit,
            targetId,
            newStatus,
            moderator,
            isOverride
          );

          // Record response time
          const responseTime = Date.now() - item.flaggedAt;
          await recordResponseTime(context.redis, subreddit, responseTime);

          // Log the action
          await addAuditEntry(context.kvStore, subreddit, {
            id: `audit_${Date.now()}_${targetId}`,
            timestamp: Date.now(),
            actionType: isOverride ? 'mod_override' : (isApprove ? 'manual_approve' : 'manual_remove'),
            targetId,
            targetUser: item.authorName,
            actor: moderator,
            details: isOverride
              ? `Mod overrode AI: approved ${item.riskTier} item (score: ${item.riskScore})`
              : `Mod ${newStatus} item (score: ${item.riskScore})`,
            riskTier: item.riskTier,
          });

          if (isRemove) {
            await recordRemoval(context.redis, subreddit, item.authorName);
            await recordRemovedAuthor(context.kvStore, subreddit, item.authorName);
          }

          if (isOverride) {
            await incrementCounter(context.kvStore, subreddit, 'false_positives', new Date().toISOString().slice(0, 10));
          }

          await incrementCounter(context.kvStore, subreddit, 'human_actioned', new Date().toISOString().slice(0, 10));
        }
      }
    } catch (error) {
      console.error('Sentinel: Error processing ModAction:', error);
    }
  },
});

// ─────────────────────────────────────────────
// Scheduler Job
// ─────────────────────────────────────────────

Devvit.addSchedulerJob({
  name: 'sentinelWatch',
  onRun: async (event, context) => {
    try {
      const subreddit = event.data?.subreddit as string;
      if (!subreddit) return;

      const result = await runScheduledIntelligence(
        context.redis,
        context.kvStore,
        subreddit
      );

      // Send modmail alert on spike
      if (result.shouldAlert) {
        try {
          const alertBody = formatSpikeAlert(subreddit, result.spikeResult);
          await context.reddit.modMail.createConversation({
            subredditName: subreddit,
            subject: `🚨 Sentinel: Activity Spike in r/${subreddit}`,
            body: alertBody,
          });
        } catch {
          console.error('Sentinel: Failed to send spike alert modmail');
        }
      }
    } catch (error) {
      console.error('Sentinel: Error in scheduled intelligence:', error);
    }
  },
});

// ─────────────────────────────────────────────
// Menu Items
// ─────────────────────────────────────────────

Devvit.addMenuItem({
  label: '🛡 Sentinel: Analyze',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: async (event, context) => {
    try {
      const targetId = event.targetId;
      if (!targetId) {
        context.ui.showToast('No target found');
        return;
      }

      if (isRateLimited(targetId)) {
        context.ui.showToast('This item was recently analyzed. Please wait.');
        return;
      }

      context.ui.showToast('🔍 Analyzing...');

      const subreddit = (await context.reddit.getCurrentSubreddit()).name;
      let content = '';
      let authorName = '';
      let contentType: 'post' | 'comment' = 'post';

      if (targetId.startsWith('t3_')) {
        const post = await context.reddit.getPostById(targetId);
        content = `${post.title} ${post.body || ''}`.trim();
        authorName = post.authorName || '[deleted]';
        contentType = 'post';
      } else if (targetId.startsWith('t1_')) {
        const comment = await context.reddit.getCommentById(targetId);
        content = comment.body || '';
        authorName = comment.authorName || '[deleted]';
        contentType = 'comment';
      }

      if (!content) {
        context.ui.showToast('Could not retrieve content');
        return;
      }

      let accountAgeDays = 365;
      let postKarma = 1000;
      let commentKarma = 1000;

      try {
        if (authorName !== '[deleted]') {
          const author = await context.reddit.getUserByUsername(authorName);
          if (author) {
            const createdAt = author.createdAt?.getTime?.() || Date.now();
            accountAgeDays = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
            postKarma = author.linkKarma ?? 0;
            commentKarma = author.commentKarma ?? 0;
          }
        }
      } catch {
        // Use defaults
      }

      const result = await classifyWithContext(
        context.redis,
        context.kvStore,
        subreddit,
        content,
        contentType,
        authorName,
        accountAgeDays,
        postKarma,
        commentKarma
      );

      const tierEmoji = {
        CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', CLEAN: '🟢',
      };

      context.ui.showToast(
        `${tierEmoji[result.riskTier]} ${result.riskTier} (Score: ${result.riskScore}/100)\n` +
        `Signals: ${result.matchedSignals.length > 0 ? result.matchedSignals.slice(0, 2).join(', ') : 'None detected'}`
      );

      // If not clean, add to queue
      if (result.riskTier !== 'CLEAN') {
        const item: SentinelItem = {
          id: targetId,
          type: contentType,
          contentPreview: content.substring(0, 280),
          authorName,
          authorKarma: postKarma + commentKarma,
          authorAccountAgeDays: accountAgeDays,
          subreddit,
          createdAt: Date.now(),
          flaggedAt: Date.now(),
          riskTier: result.riskTier,
          riskScore: result.riskScore,
          signalBreakdown: result.signalBreakdown,
          matchedSignals: result.matchedSignals,
          status: 'pending',
        };
        await addToQueue(context.redis, subreddit, item);
      }
    } catch (error) {
      console.error('Sentinel: Error in manual analysis:', error);
      context.ui.showToast('Analysis failed. Please try again.');
    }
  },
});

Devvit.addMenuItem({
  label: '📊 Create Sentinel Dashboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const subreddit = await context.reddit.getCurrentSubreddit();

      const post = await context.reddit.submitPost({
        title: '🛡 Reddit Sentinel AI — Moderation Dashboard',
        subredditName: subreddit.name,
        preview: (
          <vstack alignment="center middle" padding="large" backgroundColor="#0D1117">
            <text size="xlarge" weight="bold" color="#E6EDF3">🛡 Sentinel AI</text>
            <spacer size="medium" />
            <text size="medium" color="#7D8590">Loading dashboard...</text>
          </vstack>
        ),
      });

      // Set up the scheduler job for this subreddit
      try {
        await context.scheduler.runJob({
          name: 'sentinelWatch',
          data: { subreddit: subreddit.name },
          cron: '*/5 * * * *',
        });
      } catch {
        // Job might already be scheduled
      }

      context.ui.showToast('✅ Sentinel Dashboard created! Opening...');
      context.ui.navigateTo(post);
    } catch (error) {
      console.error('Sentinel: Error creating dashboard:', error);
      context.ui.showToast('Failed to create dashboard. Please try again.');
    }
  },
});

// ─────────────────────────────────────────────
// Custom Post Type: Sentinel Dashboard
// ─────────────────────────────────────────────

Devvit.addCustomPostType({
  name: 'SentinelDashboard',
  height: 'tall',
  render: (context) => {
    const webView = useWebView<WebviewToDevvitMessage, DevvitToWebviewMessage>({
      url: 'index.html',
      onMessage: async (message, _webViewContext) => {
        const subreddit = (await context.reddit.getCurrentSubreddit()).name;
        const currentUser = (await context.reddit.getCurrentUser())?.username || 'unknown';

        try {
          switch (message.type) {
            case 'READY': {
              // Send initial data to dashboard
              const [queue, analytics, rules, watchlist, auditLog] = await Promise.all([
                getQueue(context.redis, subreddit, 50),
                computeAnalytics(context.redis, context.kvStore, subreddit, 'day'),
                getRules(context.kvStore, subreddit),
                getWatchlist(context.kvStore, subreddit),
                getAuditLog(context.kvStore, subreddit),
              ]);

              webView.postMessage({
                type: 'INIT_DATA',
                data: { subreddit, queue, analytics, rules, watchlist, auditLog, currentUser },
              });
              break;
            }

            case 'REQUEST_DATA': {
              const tab = message.data.tab;
              switch (tab) {
                case 'queue': {
                  const queue = await getQueue(context.redis, subreddit, 50);
                  webView.postMessage({ type: 'QUEUE_UPDATE', data: queue });
                  break;
                }
                case 'analytics': {
                  const analytics = await computeAnalytics(context.redis, context.kvStore, subreddit, 'day');
                  webView.postMessage({ type: 'ANALYTICS_UPDATE', data: analytics });
                  break;
                }
                case 'rules': {
                  const rules = await getRules(context.kvStore, subreddit);
                  webView.postMessage({ type: 'RULES_UPDATE', data: rules });
                  break;
                }
                case 'watchlist': {
                  const watchlist = await getWatchlist(context.kvStore, subreddit);
                  webView.postMessage({ type: 'WATCHLIST_UPDATE', data: watchlist });
                  break;
                }
                case 'audit': {
                  const auditLog = await getAuditLog(context.kvStore, subreddit);
                  webView.postMessage({ type: 'AUDIT_UPDATE', data: auditLog });
                  break;
                }
              }
              break;
            }

            case 'MOD_ACTION': {
              const { itemId, action, reason } = message.data;
              const isApprove = action === 'approved';
              const isRemove = action === 'removed';

              try {
                if (isApprove) {
                  await context.reddit.approve(itemId);
                } else if (isRemove) {
                  await context.reddit.remove(itemId, false);
                }

                const item = await updateItemStatus(
                  context.redis, subreddit, itemId, action, currentUser
                );

                if (item) {
                  const responseTime = Date.now() - item.flaggedAt;
                  await recordResponseTime(context.redis, subreddit, responseTime);

                  const isOverride = isApprove && (item.riskTier === 'CRITICAL' || item.riskTier === 'HIGH');

                  await addAuditEntry(context.kvStore, subreddit, {
                    id: `audit_${Date.now()}_${itemId}`,
                    timestamp: Date.now(),
                    actionType: isOverride ? 'mod_override' : (isApprove ? 'manual_approve' : (isRemove ? 'manual_remove' : 'manual_dismiss')),
                    targetId: itemId,
                    targetUser: item.authorName,
                    actor: currentUser,
                    details: `${action} via Sentinel Dashboard${reason ? `: ${reason}` : ''}`,
                    riskTier: item.riskTier,
                  });

                  if (isRemove) {
                    await recordRemoval(context.redis, subreddit, item.authorName);
                    await recordRemovedAuthor(context.kvStore, subreddit, item.authorName);
                  }
                  if (isOverride) {
                    await incrementCounter(context.kvStore, subreddit, 'false_positives', new Date().toISOString().slice(0, 10));
                  }
                  await incrementCounter(context.kvStore, subreddit, 'human_actioned', new Date().toISOString().slice(0, 10));
                }

                webView.postMessage({
                  type: 'ACTION_RESULT',
                  data: { success: true, itemId, action },
                });

                // Refresh queue
                const queue = await getQueue(context.redis, subreddit, 50);
                webView.postMessage({ type: 'QUEUE_UPDATE', data: queue });

              } catch (err) {
                webView.postMessage({
                  type: 'ACTION_RESULT',
                  data: { success: false, itemId, action, error: 'Failed to execute action' },
                });
              }
              break;
            }

            case 'BULK_ACTION': {
              const { itemIds, action } = message.data;
              let successCount = 0;

              for (const itemId of itemIds) {
                try {
                  if (action === 'approved') await context.reddit.approve(itemId);
                  else if (action === 'removed') await context.reddit.remove(itemId, false);

                  await updateItemStatus(context.redis, subreddit, itemId, action, currentUser);
                  successCount++;
                } catch {
                  // Continue with other items
                }
              }

              webView.postMessage({
                type: 'TOAST',
                data: {
                  message: `${successCount}/${itemIds.length} items ${action}`,
                  level: successCount === itemIds.length ? 'success' : 'info',
                },
              });

              const queue = await getQueue(context.redis, subreddit, 50);
              webView.postMessage({ type: 'QUEUE_UPDATE', data: queue });
              break;
            }

            case 'SAVE_RULE': {
              await saveRule(context.kvStore, subreddit, message.data);
              const rules = await getRules(context.kvStore, subreddit);
              webView.postMessage({ type: 'RULES_UPDATE', data: rules });
              webView.postMessage({
                type: 'TOAST',
                data: { message: 'Rule saved successfully', level: 'success' },
              });
              break;
            }

            case 'DELETE_RULE': {
              await deleteRule(context.kvStore, subreddit, message.data.ruleId);
              const rules = await getRules(context.kvStore, subreddit);
              webView.postMessage({ type: 'RULES_UPDATE', data: rules });
              webView.postMessage({
                type: 'TOAST',
                data: { message: 'Rule deleted', level: 'info' },
              });
              break;
            }

            case 'TOGGLE_RULE': {
              await toggleRule(context.kvStore, subreddit, message.data.ruleId, message.data.enabled);
              const rules = await getRules(context.kvStore, subreddit);
              webView.postMessage({ type: 'RULES_UPDATE', data: rules });
              break;
            }

            case 'ADD_WATCHLIST': {
              await addToWatchlist(context.kvStore, subreddit, {
                username: message.data.username,
                addedAt: Date.now(),
                addedBy: currentUser,
                reason: message.data.reason,
                violationCount: 1,
              });
              await addAuditEntry(context.kvStore, subreddit, {
                id: `audit_wl_${Date.now()}`,
                timestamp: Date.now(),
                actionType: 'watchlist_add',
                targetUser: message.data.username,
                actor: currentUser,
                details: `Added to watchlist: ${message.data.reason}`,
              });
              const watchlist = await getWatchlist(context.kvStore, subreddit);
              webView.postMessage({ type: 'WATCHLIST_UPDATE', data: watchlist });
              webView.postMessage({
                type: 'TOAST',
                data: { message: `u/${message.data.username} added to watchlist`, level: 'success' },
              });
              break;
            }

            case 'REMOVE_WATCHLIST': {
              await removeFromWatchlist(context.kvStore, subreddit, message.data.username);
              await addAuditEntry(context.kvStore, subreddit, {
                id: `audit_wl_${Date.now()}`,
                timestamp: Date.now(),
                actionType: 'watchlist_remove',
                targetUser: message.data.username,
                actor: currentUser,
                details: 'Removed from watchlist',
              });
              const watchlist = await getWatchlist(context.kvStore, subreddit);
              webView.postMessage({ type: 'WATCHLIST_UPDATE', data: watchlist });
              break;
            }

            case 'MARK_FALSE_POSITIVE': {
              const item = await updateItemStatus(
                context.redis, subreddit, message.data.itemId, 'approved', currentUser, true
              );
              if (item) {
                await addAuditEntry(context.kvStore, subreddit, {
                  id: `audit_fp_${Date.now()}`,
                  timestamp: Date.now(),
                  actionType: 'mod_override',
                  targetId: message.data.itemId,
                  targetUser: item.authorName,
                  actor: currentUser,
                  details: `Marked as false positive (was ${item.riskTier}, score ${item.riskScore})`,
                  riskTier: item.riskTier,
                });
                await incrementCounter(context.kvStore, subreddit, 'false_positives', new Date().toISOString().slice(0, 10));
              }
              const queue = await getQueue(context.redis, subreddit, 50);
              webView.postMessage({ type: 'QUEUE_UPDATE', data: queue });
              webView.postMessage({
                type: 'TOAST',
                data: { message: 'Marked as false positive — improving AI accuracy', level: 'info' },
              });
              break;
            }

            case 'CHANGE_PERIOD': {
              const analytics = await computeAnalytics(
                context.redis, context.kvStore, subreddit, message.data.period
              );
              webView.postMessage({ type: 'ANALYTICS_UPDATE', data: analytics });
              break;
            }

            case 'EXPORT_AUDIT_LOG': {
              const auditLog = await getAuditLog(context.kvStore, subreddit);
              webView.postMessage({ type: 'AUDIT_UPDATE', data: auditLog });
              webView.postMessage({
                type: 'TOAST',
                data: { message: 'Audit log ready for export', level: 'info' },
              });
              break;
            }
          }
        } catch (error) {
          console.error('Sentinel: Error handling webview message:', error);
          webView.postMessage({
            type: 'TOAST',
            data: { message: 'An error occurred. Please try again.', level: 'error' },
          });
        }
      },
    });

    return (
      <vstack grow backgroundColor="#0D1117">
        <webview
          id="sentinel-dashboard"
          url="index.html"
          grow
        />
      </vstack>
    );
  },
});

// ─────────────────────────────────────────────
// Helper: Execute Reddit API Actions
// ─────────────────────────────────────────────

/**
 * Execute a Reddit API action triggered by a workflow rule.
 */
async function executeRedditAction(
  context: any,
  targetId: string,
  action: string,
  payload: string | undefined,
  subreddit: string,
  authorName: string
): Promise<void> {
  try {
    switch (action) {
      case 'remove':
        await context.reddit.remove(targetId, false);
        await recordRemoval(context.redis, subreddit, authorName);
        await recordRemovedAuthor(context.kvStore, subreddit, authorName);
        break;

      case 'report':
        await context.reddit.report(targetId, { reason: payload || 'Flagged by Sentinel AI rule' });
        break;

      case 'modmail': {
        const subject = `Sentinel Rule Alert: ${subreddit}`;
        const body = payload || `A workflow rule was triggered for content by u/${authorName} in r/${subreddit}. Item ID: ${targetId}`;
        try {
          await context.reddit.modMail.createConversation({
            subredditName: subreddit,
            subject,
            body,
          });
        } catch {
          console.error('Sentinel: Failed to send rule-triggered modmail');
        }
        break;
      }

      case 'stickyComment': {
        if (targetId.startsWith('t3_') && payload) {
          try {
            const comment = await context.reddit.submitComment({
              id: targetId,
              text: payload,
            });
            if (comment) {
              await comment.distinguish(true);
            }
          } catch {
            console.error('Sentinel: Failed to post sticky comment');
          }
        }
        break;
      }
    }
  } catch (error) {
    console.error(`Sentinel: Failed to execute Reddit action '${action}':`, error);
  }
}

export default Devvit;
