/**
 * @fileoverview Analytics aggregation service for Reddit Sentinel AI.
 *
 * Computes moderation statistics from Redis counters and KV audit logs.
 * Generates the SubredditAnalytics object consumed by the dashboard
 * Analytics tab. Calculates community health score and estimated
 * time saved.
 */

import type { RedisClient, KVStore } from '@devvit/public-api';
import type {
  SubredditAnalytics,
  AnalyticsPeriod,
  AuditLogEntry,
  SignalCount,
  DailyCount,
} from '../types/index.js';
import { AVG_MANUAL_REVIEW_SECONDS } from '../types/index.js';
import { getAuditLog, getHealthScore, saveAnalytics, saveHealthScore } from '../storage/kvStore.js';
import { getAverageResponseTime, getHourlyVolume } from '../storage/redisStore.js';

// ─────────────────────────────────────────────
// Period Helpers
// ─────────────────────────────────────────────

/**
 * Get the start timestamp for a given analytics period.
 */
function getPeriodStart(period: AnalyticsPeriod): number {
  const now = Date.now();
  switch (period) {
    case 'day': return now - 24 * 60 * 60 * 1000;
    case 'week': return now - 7 * 24 * 60 * 60 * 1000;
    case 'month': return now - 30 * 24 * 60 * 60 * 1000;
    case 'all': return 0;
  }
}

/**
 * Filter audit log entries to a specific period.
 */
function filterByPeriod(entries: AuditLogEntry[], period: AnalyticsPeriod): AuditLogEntry[] {
  const start = getPeriodStart(period);
  return entries.filter((e) => e.timestamp >= start);
}

// ─────────────────────────────────────────────
// Analytics Computation
// ─────────────────────────────────────────────

/**
 * Compute complete analytics for a subreddit and period.
 * Aggregates data from the audit log, Redis counters, and health score.
 *
 * @param redis - Devvit Redis client.
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit name.
 * @param period - Time period for aggregation.
 * @returns Fully computed SubredditAnalytics object.
 */
export async function computeAnalytics(
  redis: RedisClient,
  kv: KVStore,
  subreddit: string,
  period: AnalyticsPeriod = 'day'
): Promise<SubredditAnalytics> {
  // Get audit log and filter to period
  const allEntries = await getAuditLog(kv, subreddit);
  const entries = filterByPeriod(allEntries, period);

  // Count by action type
  let totalFlagged = 0;
  let autoCritical = 0;
  let autoHigh = 0;
  let autoActioned = 0;
  let humanActioned = 0;
  let falsePositives = 0;

  // Track signals for top violations
  const signalCounts = new Map<string, number>();

  for (const entry of entries) {
    switch (entry.actionType) {
      case 'auto_flag':
        totalFlagged++;
        if (entry.riskTier === 'CRITICAL') autoCritical++;
        if (entry.riskTier === 'HIGH') autoHigh++;
        break;
      case 'auto_remove':
        autoActioned++;
        totalFlagged++;
        if (entry.riskTier === 'CRITICAL') autoCritical++;
        break;
      case 'manual_approve':
      case 'manual_remove':
      case 'manual_dismiss':
        humanActioned++;
        break;
      case 'mod_override':
        falsePositives++;
        break;
      case 'rule_trigger':
        // Extract signal from details
        if (entry.details) {
          const signalName = extractSignalName(entry.details);
          signalCounts.set(signalName, (signalCounts.get(signalName) || 0) + 1);
        }
        break;
    }
  }

  // Also count flagging signals
  for (const entry of entries) {
    if (entry.actionType === 'auto_flag' || entry.actionType === 'auto_remove') {
      // Parse signals from the details field
      const signals = extractSignalsFromDetails(entry.details);
      for (const signal of signals) {
        signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
      }
    }
  }

  // Sort top signals by count
  const topSignals: SignalCount[] = Array.from(signalCounts.entries())
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Get average response time from Redis
  const avgResponseTimeMs = await getAverageResponseTime(redis, subreddit);

  // Get community health score
  const communityHealthScore = await getHealthScore(kv, subreddit);

  // Calculate estimated hours saved
  // Each auto-actioned item saves ~45 seconds of manual review
  const estimatedHoursSaved = parseFloat(
    ((autoActioned * AVG_MANUAL_REVIEW_SECONDS) / 3600).toFixed(1)
  );

  // Build daily volume data
  const dailyVolume = await buildDailyVolume(redis, subreddit, period);

  const analytics: SubredditAnalytics = {
    subreddit,
    period,
    totalFlagged,
    autoCritical,
    autoHigh,
    humanActioned,
    autoActioned,
    falsePositives,
    avgResponseTimeMs,
    communityHealthScore,
    estimatedHoursSaved,
    topSignals,
    dailyVolume,
  };

  // Cache the computed analytics
  await saveAnalytics(kv, subreddit, analytics);

  return analytics;
}

// ─────────────────────────────────────────────
// Community Health Score
// ─────────────────────────────────────────────

/**
 * Compute and update the community health score.
 * Score is a composite of:
 *   - Low false positive rate (higher = healthier)
 *   - Fast response time (lower = healthier)
 *   - Low CRITICAL volume relative to total (lower = healthier)
 *   - Active moderation (more human actions = healthier)
 *
 * Score range: 0–100 (higher is better).
 * Called periodically by the scheduler.
 */
export async function updateHealthScore(
  redis: RedisClient,
  kv: KVStore,
  subreddit: string
): Promise<number> {
  const entries = await getAuditLog(kv, subreddit);
  const recentEntries = filterByPeriod(entries, 'week');

  if (recentEntries.length === 0) {
    // No activity — assume healthy
    await saveHealthScore(kv, subreddit, 75);
    return 75;
  }

  // Factor 1: False positive rate (lower is better)
  const totalFlagged = recentEntries.filter(
    (e) => e.actionType === 'auto_flag' || e.actionType === 'auto_remove'
  ).length;
  const falsePositives = recentEntries.filter((e) => e.actionType === 'mod_override').length;
  const fpRate = totalFlagged > 0 ? falsePositives / totalFlagged : 0;
  const fpScore = Math.max(0, 100 - fpRate * 200); // 0% FP = 100, 50%+ FP = 0

  // Factor 2: Response time (lower is better, target < 5 min)
  const avgResponseMs = await getAverageResponseTime(redis, subreddit);
  const avgResponseMin = avgResponseMs / 60000;
  const responseScore = avgResponseMin <= 1 ? 100 :
    avgResponseMin <= 5 ? 80 :
    avgResponseMin <= 15 ? 60 :
    avgResponseMin <= 60 ? 40 : 20;

  // Factor 3: Critical volume ratio (lower is better)
  const criticalCount = recentEntries.filter(
    (e) => e.riskTier === 'CRITICAL'
  ).length;
  const criticalRatio = totalFlagged > 0 ? criticalCount / totalFlagged : 0;
  const criticalScore = Math.max(0, 100 - criticalRatio * 300);

  // Factor 4: Active moderation ratio
  const humanActions = recentEntries.filter(
    (e) => e.actionType === 'manual_approve' || e.actionType === 'manual_remove'
  ).length;
  const moderationScore = totalFlagged > 0
    ? Math.min(100, (humanActions / Math.max(totalFlagged, 1)) * 150)
    : 50;

  // Weighted composite
  const score = Math.round(
    fpScore * 0.30 +
    responseScore * 0.25 +
    criticalScore * 0.25 +
    moderationScore * 0.20
  );

  const clampedScore = Math.min(Math.max(score, 0), 100);
  await saveHealthScore(kv, subreddit, clampedScore);
  return clampedScore;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Extract a short signal name from an audit log detail string.
 */
function extractSignalName(details: string): string {
  // Try to extract the rule name
  const ruleMatch = details.match(/Rule "([^"]+)"/);
  if (ruleMatch) return ruleMatch[1];
  // Fallback: first 40 chars
  return details.substring(0, 40);
}

/**
 * Extract individual signals from a comma-separated details string.
 */
function extractSignalsFromDetails(details: string): string[] {
  // Signals are stored as "Signal1 | Signal2 | Signal3"
  if (details.includes('|')) {
    return details.split('|').map((s) => s.trim()).filter(Boolean);
  }
  // Or as a single signal
  return details ? [details.substring(0, 50)] : [];
}

/**
 * Build daily volume data for the chart.
 */
async function buildDailyVolume(
  redis: RedisClient,
  subreddit: string,
  period: AnalyticsPeriod
): Promise<DailyCount[]> {
  const days = period === 'day' ? 1 :
    period === 'week' ? 7 :
    period === 'month' ? 30 : 90;

  const volumes: DailyCount[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);

    // Sum hourly volumes for this date
    let dailyTotal = 0;
    for (let h = 0; h < 24; h++) {
      const hourStr = `${dateStr}T${h.toString().padStart(2, '0')}`;
      const hourVol = await getHourlyVolume(redis, subreddit, hourStr);
      dailyTotal += hourVol;
    }

    volumes.push({ date: dateStr, count: dailyTotal });
  }

  return volumes;
}
