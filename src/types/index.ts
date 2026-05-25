/**
 * @fileoverview Core type definitions for Reddit Sentinel AI.
 * All shared interfaces, enums, and type aliases used across
 * services, storage, triggers, and the dashboard UI.
 */

// ─────────────────────────────────────────────
// Risk & Status Enums
// ─────────────────────────────────────────────

/** Content risk classification tiers. */
export type RiskTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';

/** Type of Reddit content being analyzed. */
export type ContentType = 'post' | 'comment';

/** Current moderation status of a flagged item. */
export type ActionStatus = 'pending' | 'approved' | 'removed' | 'dismissed';

/** Time period for analytics aggregation. */
export type AnalyticsPeriod = 'day' | 'week' | 'month' | 'all';

// ─────────────────────────────────────────────
// Classifier Output
// ─────────────────────────────────────────────

/** Breakdown of risk signals from each scoring dimension. */
export type SignalBreakdown = {
  /** Content analysis score (0–100), weighted at 40%. */
  contentScore: number;
  /** Author profile score (0–100), weighted at 35%. */
  authorScore: number;
  /** Behavioral pattern score (0–100), weighted at 25%. */
  behaviorScore: number;
};

/** Result of the multi-signal classifier for a single piece of content. */
export type ClassifierResult = {
  riskScore: number;
  riskTier: RiskTier;
  signalBreakdown: SignalBreakdown;
  matchedSignals: string[];
  confidenceScore: number;
};

// ─────────────────────────────────────────────
// Flagged Item (core queue entity)
// ─────────────────────────────────────────────

/** A post or comment that has been analyzed and flagged by Sentinel. */
export type SentinelItem = {
  /** Reddit fullname ID (t3_ for posts, t1_ for comments). */
  id: string;
  /** Whether this is a post or comment. */
  type: ContentType;
  /** First 280 characters of the content for preview. */
  contentPreview: string;
  /** Reddit username of the content author. */
  authorName: string;
  /** Combined karma of the author at time of flagging. */
  authorKarma: number;
  /** Author's account age in days at time of flagging. */
  authorAccountAgeDays: number;
  /** Subreddit where the content was posted. */
  subreddit: string;
  /** Unix timestamp (ms) when the content was created. */
  createdAt: number;
  /** Unix timestamp (ms) when Sentinel flagged the content. */
  flaggedAt: number;
  /** Assigned risk tier. */
  riskTier: RiskTier;
  /** Composite risk score (0–100). */
  riskScore: number;
  /** Per-signal score breakdown. */
  signalBreakdown: SignalBreakdown;
  /** Human-readable reasons the content was flagged. */
  matchedSignals: string[];
  /** Current moderation status. */
  status: ActionStatus;
  /** Username of the moderator who reviewed, if any. */
  reviewedBy?: string;
  /** Unix timestamp (ms) when the item was reviewed. */
  reviewedAt?: number;
  /** True if the moderator overrode the AI recommendation. */
  isModOverride?: boolean;
  /** Permalink to the original content. */
  permalink?: string;
};

// ─────────────────────────────────────────────
// Workflow Rule Engine
// ─────────────────────────────────────────────

/** Fields available as rule conditions. */
export type ConditionField =
  | 'keyword'
  | 'riskScore'
  | 'accountAgeDays'
  | 'karma'
  | 'hasFlair'
  | 'hasMedia'
  | 'hasLink'
  | 'isFirstPost'
  | 'capsRatio';

/** Comparison operators for rule conditions. */
export type ConditionOperator = 'contains' | 'gt' | 'lt' | 'eq' | 'is' | 'isNot';

/** A single condition in a workflow rule. */
export type RuleCondition = {
  field: ConditionField;
  operator: ConditionOperator;
  value: string | number | boolean;
};

/** Action types that can be triggered by a workflow rule. */
export type RuleActionType =
  | 'remove'
  | 'flair'
  | 'watchlist'
  | 'modmail'
  | 'stickyComment'
  | 'report';

/** A single action to execute when a rule matches. */
export type RuleAction = {
  type: RuleActionType;
  /** Context-dependent: flair text, comment body, modmail subject, etc. */
  payload?: string;
};

/** A complete workflow rule with conditions and actions. */
export type WorkflowRule = {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Whether the rule is currently active. */
  enabled: boolean;
  /** Execution priority (lower number = higher priority). */
  priority: number;
  /** All conditions must match for the rule to trigger (AND logic). */
  conditions: RuleCondition[];
  /** Actions to execute when the rule triggers. */
  actions: RuleAction[];
  /** Username of the moderator who created the rule. */
  createdBy: string;
  /** How many times this rule has been triggered. */
  triggerCount: number;
  /** Unix timestamp (ms) of the last trigger. */
  lastTriggeredAt?: number;
};

// ─────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────

/** Aggregated moderation statistics for a subreddit. */
export type SubredditAnalytics = {
  subreddit: string;
  period: AnalyticsPeriod;
  totalFlagged: number;
  autoCritical: number;
  autoHigh: number;
  humanActioned: number;
  autoActioned: number;
  /** Number of items where a mod marked "AI was wrong". */
  falsePositives: number;
  /** Average time from flag to mod action, in milliseconds. */
  avgResponseTimeMs: number;
  /** Composite community health score (0–100). */
  communityHealthScore: number;
  /** Estimated hours of mod time saved by Sentinel. */
  estimatedHoursSaved: number;
  /** Top triggered signals, sorted by frequency. */
  topSignals: SignalCount[];
  /** Daily flagging volume for trend charts. */
  dailyVolume: DailyCount[];
};

/** A signal type and its occurrence count. */
export type SignalCount = {
  signal: string;
  count: number;
};

/** A date and its associated count for volume charts. */
export type DailyCount = {
  date: string;
  count: number;
};

// ─────────────────────────────────────────────
// Watchlist
// ─────────────────────────────────────────────

/** A user being monitored on the watchlist. */
export type WatchlistEntry = {
  username: string;
  /** Unix timestamp (ms) when added to watchlist. */
  addedAt: number;
  /** Moderator who added the user. */
  addedBy: string;
  /** Reason for being added. */
  reason: string;
  /** Cumulative violation count. */
  violationCount: number;
  /** Optional mod note. */
  note?: string;
};

// ─────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────

/** Type of action recorded in the audit log. */
export type AuditActionType =
  | 'auto_remove'
  | 'auto_flag'
  | 'manual_approve'
  | 'manual_remove'
  | 'manual_dismiss'
  | 'rule_trigger'
  | 'watchlist_add'
  | 'watchlist_remove'
  | 'mod_override'
  | 'spike_alert';

/** A single entry in the audit trail. */
export type AuditLogEntry = {
  /** Unique entry ID. */
  id: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** What kind of action was taken. */
  actionType: AuditActionType;
  /** The item ID this action relates to (if applicable). */
  targetId?: string;
  /** The username targeted (if applicable). */
  targetUser?: string;
  /** Who performed the action ('sentinel' for AI, username for mods). */
  actor: string;
  /** Additional context or reasoning. */
  details: string;
  /** Risk tier at time of action. */
  riskTier?: RiskTier;
};

// ─────────────────────────────────────────────
// Modmail Templates
// ─────────────────────────────────────────────

/** Categories for modmail classification. */
export type ModmailCategory =
  | 'ban_appeal'
  | 'spam_report'
  | 'rule_question'
  | 'harassment'
  | 'general';

/** A modmail response template. */
export type ModmailTemplate = {
  id: string;
  category: ModmailCategory;
  name: string;
  subject: string;
  body: string;
  /** Placeholders like {{username}}, {{subreddit}}, {{rule}}. */
  variables: string[];
};

// ─────────────────────────────────────────────
// Webview ↔ Devvit Message Protocol
// ─────────────────────────────────────────────

/** Messages sent FROM the Devvit Blocks host TO the webview. */
export type DevvitToWebviewMessage =
  | { type: 'INIT_DATA'; data: DashboardInitData }
  | { type: 'QUEUE_UPDATE'; data: SentinelItem[] }
  | { type: 'ANALYTICS_UPDATE'; data: SubredditAnalytics }
  | { type: 'RULES_UPDATE'; data: WorkflowRule[] }
  | { type: 'WATCHLIST_UPDATE'; data: WatchlistEntry[] }
  | { type: 'AUDIT_UPDATE'; data: AuditLogEntry[] }
  | { type: 'MODMAIL_UPDATE'; data: any[] }
  | { type: 'MODMAIL_DRAFT_RESULT'; data: { body: string; category: string; sentiment: string } }
  | { type: 'ACTION_RESULT'; data: { success: boolean; itemId: string; action: string; error?: string } }
  | { type: 'TOAST'; data: { message: string; level: 'success' | 'error' | 'info' } };

/** Messages sent FROM the webview TO the Devvit Blocks host. */
export type WebviewToDevvitMessage =
  | { type: 'READY' }
  | { type: 'REQUEST_DATA'; data: { tab: DashboardTab } }
  | { type: 'MOD_ACTION'; data: { itemId: string; action: ActionStatus; reason?: string } }
  | { type: 'BULK_ACTION'; data: { itemIds: string[]; action: ActionStatus } }
  | { type: 'SAVE_RULE'; data: WorkflowRule }
  | { type: 'DELETE_RULE'; data: { ruleId: string } }
  | { type: 'TOGGLE_RULE'; data: { ruleId: string; enabled: boolean } }
  | { type: 'ADD_WATCHLIST'; data: { username: string; reason: string } }
  | { type: 'REMOVE_WATCHLIST'; data: { username: string } }
  | { type: 'MARK_FALSE_POSITIVE'; data: { itemId: string } }
  | { type: 'EXPORT_AUDIT_LOG' }
  | { type: 'CHANGE_PERIOD'; data: { period: AnalyticsPeriod } }
  | { type: 'GENERATE_MODMAIL_DRAFT'; data: { senderName: string; subject: string; body: string } }
  | { type: 'SEND_MODMAIL_REPLY'; data: { conversationId: string; body: string } };

/** Dashboard tab identifiers. */
export type DashboardTab = 'queue' | 'analytics' | 'rules' | 'watchlist' | 'audit' | 'modmail';

/** Initial payload sent to the webview on load. */
export type DashboardInitData = {
  subreddit: string;
  queue: SentinelItem[];
  analytics: SubredditAnalytics;
  rules: WorkflowRule[];
  watchlist: WatchlistEntry[];
  auditLog: AuditLogEntry[];
  currentUser: string;
};

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Risk score thresholds for tier classification. */
export const RISK_THRESHOLDS = {
  CRITICAL: 80,
  HIGH: 60,
  MEDIUM: 40,
  LOW: 20,
  CLEAN: 0,
} as const;

/** Redis key namespace prefixes. */
export const REDIS_KEYS = {
  /** Per-item data: sentinel:item:{subreddit}:{id} */
  ITEM: 'sentinel:item',
  /** Sorted set of items by score: sentinel:queue:{subreddit} */
  QUEUE: 'sentinel:queue',
  /** Author activity tracking: sentinel:activity:{subreddit}:{author} */
  ACTIVITY: 'sentinel:activity',
  /** Content hash for duplicate detection: sentinel:hash:{subreddit}:{hash} */
  CONTENT_HASH: 'sentinel:hash',
  /** Daily volume counter: sentinel:volume:{subreddit}:{date} */
  VOLUME: 'sentinel:volume',
  /** Hourly volume for spike detection: sentinel:hourly:{subreddit}:{hour} */
  HOURLY: 'sentinel:hourly',
  /** Author removal history: sentinel:removals:{subreddit}:{author} */
  REMOVALS: 'sentinel:removals',
  /** Response time tracking: sentinel:response:{subreddit} */
  RESPONSE_TIME: 'sentinel:response',
} as const;

/** KV Store key prefixes. */
export const KV_KEYS = {
  /** Workflow rules: sentinel:rules:{subreddit} */
  RULES: 'sentinel:rules',
  /** Watchlist: sentinel:watchlist:{subreddit} */
  WATCHLIST: 'sentinel:watchlist',
  /** Audit log: sentinel:audit:{subreddit} */
  AUDIT: 'sentinel:audit',
  /** Analytics snapshots: sentinel:analytics:{subreddit}:{period} */
  ANALYTICS: 'sentinel:analytics',
  /** Community health score: sentinel:health:{subreddit} */
  HEALTH: 'sentinel:health',
  /** Modmail templates: sentinel:templates:{subreddit} */
  TEMPLATES: 'sentinel:templates',
  /** App settings: sentinel:settings:{subreddit} */
  SETTINGS: 'sentinel:settings',
  /** Removed authors log: sentinel:removed:{subreddit} */
  REMOVED_AUTHORS: 'sentinel:removed',
} as const;

/** Default TTLs in seconds. */
export const TTL = {
  /** Flagged items expire after 7 days. */
  ITEM: 7 * 24 * 60 * 60,
  /** Activity tracking windows: 1 hour. */
  ACTIVITY: 60 * 60,
  /** Content hashes for dedup: 24 hours. */
  CONTENT_HASH: 24 * 60 * 60,
  /** Hourly volume counters: 48 hours. */
  HOURLY: 48 * 60 * 60,
} as const;

/** Average time (seconds) a mod spends reviewing one item manually. */
export const AVG_MANUAL_REVIEW_SECONDS = 45;
