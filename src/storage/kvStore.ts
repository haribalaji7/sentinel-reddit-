/**
 * @fileoverview Typed wrappers for Devvit KV Store operations.
 * Manages persistent data: workflow rules, watchlists, audit logs,
 * analytics snapshots, modmail templates, and app settings.
 */

import type { KVStore } from '@devvit/public-api';
import type {
  WorkflowRule,
  WatchlistEntry,
  AuditLogEntry,
  SubredditAnalytics,
  ModmailTemplate,
  AnalyticsPeriod,
} from '../types/index.js';
import { KV_KEYS } from '../types/index.js';

// ─────────────────────────────────────────────
// Generic KV Helpers
// ─────────────────────────────────────────────

/**
 * Safely parse a JSON string from KV store.
 * Returns the default value if parsing fails or key doesn't exist.
 */
async function getJSON<T>(kv: KVStore, key: string, defaultValue: T): Promise<T> {
  try {
    const raw = await kv.get<string>(key);
    if (!raw) return defaultValue;
    return typeof raw === 'string' ? JSON.parse(raw) as T : raw as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Store a value as JSON in KV store.
 */
async function setJSON<T>(kv: KVStore, key: string, value: T): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

// ─────────────────────────────────────────────
// Workflow Rules
// ─────────────────────────────────────────────

/**
 * Get all workflow rules for a subreddit, sorted by priority.
 */
export async function getRules(kv: KVStore, subreddit: string): Promise<WorkflowRule[]> {
  const key = `${KV_KEYS.RULES}:${subreddit}`;
  const rules = await getJSON<WorkflowRule[]>(kv, key, []);
  return rules.sort((a, b) => a.priority - b.priority);
}

/**
 * Save a workflow rule. If a rule with the same ID exists, it's updated.
 */
export async function saveRule(kv: KVStore, subreddit: string, rule: WorkflowRule): Promise<void> {
  const rules = await getRules(kv, subreddit);
  const idx = rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) {
    rules[idx] = rule;
  } else {
    rules.push(rule);
  }
  const key = `${KV_KEYS.RULES}:${subreddit}`;
  await setJSON(kv, key, rules);
}

/**
 * Delete a workflow rule by ID.
 */
export async function deleteRule(kv: KVStore, subreddit: string, ruleId: string): Promise<void> {
  const rules = await getRules(kv, subreddit);
  const filtered = rules.filter((r) => r.id !== ruleId);
  const key = `${KV_KEYS.RULES}:${subreddit}`;
  await setJSON(kv, key, filtered);
}

/**
 * Toggle a rule's enabled state.
 */
export async function toggleRule(
  kv: KVStore,
  subreddit: string,
  ruleId: string,
  enabled: boolean
): Promise<void> {
  const rules = await getRules(kv, subreddit);
  const rule = rules.find((r) => r.id === ruleId);
  if (rule) {
    rule.enabled = enabled;
    const key = `${KV_KEYS.RULES}:${subreddit}`;
    await setJSON(kv, key, rules);
  }
}

/**
 * Increment a rule's trigger count and update its last triggered timestamp.
 */
export async function recordRuleTrigger(
  kv: KVStore,
  subreddit: string,
  ruleId: string
): Promise<void> {
  const rules = await getRules(kv, subreddit);
  const rule = rules.find((r) => r.id === ruleId);
  if (rule) {
    rule.triggerCount += 1;
    rule.lastTriggeredAt = Date.now();
    const key = `${KV_KEYS.RULES}:${subreddit}`;
    await setJSON(kv, key, rules);
  }
}

// ─────────────────────────────────────────────
// Watchlist
// ─────────────────────────────────────────────

/**
 * Get the full watchlist for a subreddit.
 */
export async function getWatchlist(kv: KVStore, subreddit: string): Promise<WatchlistEntry[]> {
  const key = `${KV_KEYS.WATCHLIST}:${subreddit}`;
  return getJSON<WatchlistEntry[]>(kv, key, []);
}

/**
 * Add a user to the watchlist or update their entry.
 */
export async function addToWatchlist(
  kv: KVStore,
  subreddit: string,
  entry: WatchlistEntry
): Promise<void> {
  const list = await getWatchlist(kv, subreddit);
  const idx = list.findIndex((e) => e.username === entry.username);
  if (idx >= 0) {
    // Update existing entry, increment violation count
    list[idx] = {
      ...list[idx],
      ...entry,
      violationCount: list[idx].violationCount + 1,
    };
  } else {
    list.push(entry);
  }
  const key = `${KV_KEYS.WATCHLIST}:${subreddit}`;
  await setJSON(kv, key, list);
}

/**
 * Remove a user from the watchlist.
 */
export async function removeFromWatchlist(
  kv: KVStore,
  subreddit: string,
  username: string
): Promise<void> {
  const list = await getWatchlist(kv, subreddit);
  const filtered = list.filter((e) => e.username !== username);
  const key = `${KV_KEYS.WATCHLIST}:${subreddit}`;
  await setJSON(kv, key, filtered);
}

/**
 * Check if a user is on the watchlist.
 */
export async function isOnWatchlist(
  kv: KVStore,
  subreddit: string,
  username: string
): Promise<boolean> {
  const list = await getWatchlist(kv, subreddit);
  return list.some((e) => e.username === username);
}

// ─────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────

/** Maximum number of audit log entries to retain per subreddit. */
const MAX_AUDIT_ENTRIES = 500;

/**
 * Get the audit log for a subreddit, newest entries first.
 */
export async function getAuditLog(kv: KVStore, subreddit: string): Promise<AuditLogEntry[]> {
  const key = `${KV_KEYS.AUDIT}:${subreddit}`;
  return getJSON<AuditLogEntry[]>(kv, key, []);
}

/**
 * Append an entry to the audit log. Trims to MAX_AUDIT_ENTRIES.
 */
export async function addAuditEntry(
  kv: KVStore,
  subreddit: string,
  entry: AuditLogEntry
): Promise<void> {
  const log = await getAuditLog(kv, subreddit);
  // Prepend newest entry
  log.unshift(entry);
  // Trim to max size
  if (log.length > MAX_AUDIT_ENTRIES) {
    log.length = MAX_AUDIT_ENTRIES;
  }
  const key = `${KV_KEYS.AUDIT}:${subreddit}`;
  await setJSON(kv, key, log);
}

// ─────────────────────────────────────────────
// Analytics Snapshots
// ─────────────────────────────────────────────

/**
 * Get analytics for a subreddit and period.
 */
export async function getAnalytics(
  kv: KVStore,
  subreddit: string,
  period: AnalyticsPeriod = 'day'
): Promise<SubredditAnalytics> {
  const key = `${KV_KEYS.ANALYTICS}:${subreddit}:${period}`;
  return getJSON<SubredditAnalytics>(kv, key, createEmptyAnalytics(subreddit, period));
}

/**
 * Save analytics snapshot.
 */
export async function saveAnalytics(
  kv: KVStore,
  subreddit: string,
  analytics: SubredditAnalytics
): Promise<void> {
  const key = `${KV_KEYS.ANALYTICS}:${subreddit}:${analytics.period}`;
  await setJSON(kv, key, analytics);
}

/**
 * Get or update the community health score.
 */
export async function getHealthScore(kv: KVStore, subreddit: string): Promise<number> {
  const key = `${KV_KEYS.HEALTH}:${subreddit}`;
  const raw = await kv.get<string>(key);
  return raw ? parseInt(raw as string, 10) || 75 : 75;
}

/**
 * Save the community health score.
 */
export async function saveHealthScore(kv: KVStore, subreddit: string, score: number): Promise<void> {
  const key = `${KV_KEYS.HEALTH}:${subreddit}`;
  await kv.put(key, score.toString());
}

/**
 * Create an empty analytics object with zeroed metrics.
 */
function createEmptyAnalytics(subreddit: string, period: AnalyticsPeriod): SubredditAnalytics {
  return {
    subreddit,
    period,
    totalFlagged: 0,
    autoCritical: 0,
    autoHigh: 0,
    humanActioned: 0,
    autoActioned: 0,
    falsePositives: 0,
    avgResponseTimeMs: 0,
    communityHealthScore: 75,
    estimatedHoursSaved: 0,
    topSignals: [],
    dailyVolume: [],
  };
}

// ─────────────────────────────────────────────
// Modmail Templates
// ─────────────────────────────────────────────

/**
 * Get all modmail templates for a subreddit.
 */
export async function getTemplates(kv: KVStore, subreddit: string): Promise<ModmailTemplate[]> {
  const key = `${KV_KEYS.TEMPLATES}:${subreddit}`;
  const templates = await getJSON<ModmailTemplate[]>(kv, key, []);

  // Return defaults if none exist
  if (templates.length === 0) return getDefaultTemplates();
  return templates;
}

/**
 * Save a modmail template.
 */
export async function saveTemplate(
  kv: KVStore,
  subreddit: string,
  template: ModmailTemplate
): Promise<void> {
  const templates = await getTemplates(kv, subreddit);
  const idx = templates.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    templates[idx] = template;
  } else {
    templates.push(template);
  }
  const key = `${KV_KEYS.TEMPLATES}:${subreddit}`;
  await setJSON(kv, key, templates);
}

// ─────────────────────────────────────────────
// Removed Authors (for author signal scoring)
// ─────────────────────────────────────────────

/**
 * Record that an author had content removed.
 */
export async function recordRemovedAuthor(
  kv: KVStore,
  subreddit: string,
  author: string
): Promise<void> {
  const key = `${KV_KEYS.REMOVED_AUTHORS}:${subreddit}`;
  const list = await getJSON<string[]>(kv, key, []);
  if (!list.includes(author)) {
    list.push(author);
    // Keep last 1000 removed authors
    if (list.length > 1000) list.shift();
    await setJSON(kv, key, list);
  }
}

/**
 * Check if an author has had content previously removed.
 */
export async function hasBeenRemoved(
  kv: KVStore,
  subreddit: string,
  author: string
): Promise<boolean> {
  const key = `${KV_KEYS.REMOVED_AUTHORS}:${subreddit}`;
  const list = await getJSON<string[]>(kv, key, []);
  return list.includes(author);
}

// ─────────────────────────────────────────────
// Counters (for analytics aggregation)
// ─────────────────────────────────────────────

/**
 * Increment a named counter for the current period.
 */
export async function incrementCounter(
  kv: KVStore,
  subreddit: string,
  counter: string,
  period: string
): Promise<void> {
  const key = `${KV_KEYS.ANALYTICS}:${subreddit}:counter:${counter}:${period}`;
  const current = await getJSON<number>(kv, key, 0);
  await setJSON(kv, key, current + 1);
}

/**
 * Get a named counter value.
 */
export async function getCounter(
  kv: KVStore,
  subreddit: string,
  counter: string,
  period: string
): Promise<number> {
  const key = `${KV_KEYS.ANALYTICS}:${subreddit}:counter:${counter}:${period}`;
  return getJSON<number>(kv, key, 0);
}

// ─────────────────────────────────────────────
// Default Modmail Templates
// ─────────────────────────────────────────────

/**
 * Factory for default modmail templates provided out of the box.
 */
function getDefaultTemplates(): ModmailTemplate[] {
  return [
    {
      id: 'tmpl_ban_appeal',
      category: 'ban_appeal',
      name: 'Ban Appeal Response',
      subject: 'Re: Ban Appeal for r/{{subreddit}}',
      body: `Hi {{username}},

Thank you for reaching out regarding your ban from r/{{subreddit}}.

We've reviewed your appeal and {{decision}}. {{reason}}

If you have any further questions, please don't hesitate to ask.

— r/{{subreddit}} Mod Team`,
      variables: ['username', 'subreddit', 'decision', 'reason'],
    },
    {
      id: 'tmpl_spam_report',
      category: 'spam_report',
      name: 'Spam Report Acknowledgment',
      subject: 'Re: Spam Report in r/{{subreddit}}',
      body: `Hi {{username}},

Thank you for reporting spam in r/{{subreddit}}. We take these reports seriously and have {{action}}.

Your vigilance helps keep our community clean.

— r/{{subreddit}} Mod Team`,
      variables: ['username', 'subreddit', 'action'],
    },
    {
      id: 'tmpl_rule_question',
      category: 'rule_question',
      name: 'Rule Clarification',
      subject: 'Re: Rule Question for r/{{subreddit}}',
      body: `Hi {{username}},

Thanks for asking about our rules. Regarding your question:

{{answer}}

You can find our full rules in the sidebar. Let us know if anything else is unclear.

— r/{{subreddit}} Mod Team`,
      variables: ['username', 'subreddit', 'answer'],
    },
    {
      id: 'tmpl_harassment',
      category: 'harassment',
      name: 'Harassment Report Response',
      subject: 'Re: Harassment Report in r/{{subreddit}}',
      body: `Hi {{username}},

We've received your harassment report and are investigating. We take the safety of our community members very seriously.

{{action_taken}}

If you experience any further issues, please report them immediately.

— r/{{subreddit}} Mod Team`,
      variables: ['username', 'subreddit', 'action_taken'],
    },
    {
      id: 'tmpl_general',
      category: 'general',
      name: 'General Inquiry',
      subject: 'Re: Your Message to r/{{subreddit}}',
      body: `Hi {{username}},

Thank you for contacting the r/{{subreddit}} mod team.

{{response}}

— r/{{subreddit}} Mod Team`,
      variables: ['username', 'subreddit', 'response'],
    },
  ];
}
