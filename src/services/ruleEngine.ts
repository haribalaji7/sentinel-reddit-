/**
 * @fileoverview Custom workflow rule evaluation and execution engine.
 *
 * Mods create IF/THEN rules via the dashboard Rule Builder.
 * On every PostCreate/CommentCreate, after the classifier runs,
 * the rule engine evaluates all enabled rules against the flagged item.
 * Rules are priority-ordered; all matching rules execute their actions.
 */

import type { RedisClient, KVStore } from '@devvit/public-api';
import type {
  WorkflowRule,
  RuleCondition,
  RuleAction,
  SentinelItem,
  AuditLogEntry,
} from '../types/index.js';
import { getRules, recordRuleTrigger, addAuditEntry, addToWatchlist } from '../storage/kvStore.js';

// ─────────────────────────────────────────────
// Condition Evaluator
// ─────────────────────────────────────────────

/**
 * Evaluate a single rule condition against a flagged item.
 * All conditions in a rule use AND logic — all must match.
 */
function evaluateCondition(condition: RuleCondition, item: SentinelItem): boolean {
  const { field, operator, value } = condition;

  switch (field) {
    case 'keyword': {
      const searchText = item.contentPreview.toLowerCase();
      const keyword = String(value).toLowerCase();
      if (operator === 'contains') return searchText.includes(keyword);
      if (operator === 'isNot') return !searchText.includes(keyword);
      return false;
    }

    case 'riskScore': {
      const numValue = Number(value);
      if (operator === 'gt') return item.riskScore > numValue;
      if (operator === 'lt') return item.riskScore < numValue;
      if (operator === 'eq') return item.riskScore === numValue;
      return false;
    }

    case 'accountAgeDays': {
      const numValue = Number(value);
      if (operator === 'gt') return item.authorAccountAgeDays > numValue;
      if (operator === 'lt') return item.authorAccountAgeDays < numValue;
      if (operator === 'eq') return item.authorAccountAgeDays === numValue;
      return false;
    }

    case 'karma': {
      const numValue = Number(value);
      if (operator === 'gt') return item.authorKarma > numValue;
      if (operator === 'lt') return item.authorKarma < numValue;
      if (operator === 'eq') return item.authorKarma === numValue;
      return false;
    }

    case 'hasFlair': {
      // Simplified: check if the content mentions flair-like markers
      if (operator === 'is') return Boolean(value) === true;
      if (operator === 'isNot') return Boolean(value) === false;
      return false;
    }

    case 'hasMedia': {
      const hasMedia = /\.(jpg|jpeg|png|gif|webp|mp4|webm)/i.test(item.contentPreview);
      if (operator === 'is') return hasMedia === Boolean(value);
      if (operator === 'isNot') return hasMedia !== Boolean(value);
      return false;
    }

    case 'hasLink': {
      const hasLink = /https?:\/\//i.test(item.contentPreview);
      if (operator === 'is') return hasLink === Boolean(value);
      if (operator === 'isNot') return hasLink !== Boolean(value);
      return false;
    }

    case 'isFirstPost': {
      // Check matchedSignals for first-post indicator
      const isFirst = item.matchedSignals.some((s) => s.includes('First-time poster'));
      if (operator === 'is') return isFirst === Boolean(value);
      if (operator === 'isNot') return isFirst !== Boolean(value);
      return false;
    }

    case 'capsRatio': {
      const alphaChars = item.contentPreview.replace(/[^a-zA-Z]/g, '');
      const upperCount = item.contentPreview.replace(/[^A-Z]/g, '').length;
      const ratio = alphaChars.length > 0 ? upperCount / alphaChars.length : 0;
      const threshold = Number(value);
      if (operator === 'gt') return ratio > threshold;
      if (operator === 'lt') return ratio < threshold;
      return false;
    }

    default:
      return false;
  }
}

/**
 * Check if all conditions of a rule match the given item.
 */
function evaluateRule(rule: WorkflowRule, item: SentinelItem): boolean {
  if (!rule.enabled) return false;
  if (rule.conditions.length === 0) return false;

  return rule.conditions.every((condition) => evaluateCondition(condition, item));
}

// ─────────────────────────────────────────────
// Action Result
// ─────────────────────────────────────────────

/** Describes an action the rule engine wants to execute. */
export interface RuleActionRequest {
  /** The rule that triggered this action. */
  rule: WorkflowRule;
  /** The specific action to execute. */
  action: RuleAction;
  /** The item the action applies to. */
  item: SentinelItem;
}

// ─────────────────────────────────────────────
// Rule Engine Entry Point
// ─────────────────────────────────────────────

/**
 * Evaluate all enabled rules against a flagged item.
 * Returns a list of action requests for the caller to execute.
 *
 * Rules are evaluated in priority order (lower number = higher priority).
 * All matching rules produce action requests.
 *
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit name.
 * @param item - The flagged item to evaluate.
 * @returns Array of action requests from matching rules.
 */
export async function evaluateRules(
  kv: KVStore,
  subreddit: string,
  item: SentinelItem
): Promise<RuleActionRequest[]> {
  const rules = await getRules(kv, subreddit);
  const actionRequests: RuleActionRequest[] = [];

  for (const rule of rules) {
    if (evaluateRule(rule, item)) {
      // Record the trigger
      await recordRuleTrigger(kv, subreddit, rule.id);

      // Create audit entry for the rule trigger
      const auditEntry: AuditLogEntry = {
        id: `audit_rule_${rule.id}_${Date.now()}`,
        timestamp: Date.now(),
        actionType: 'rule_trigger',
        targetId: item.id,
        targetUser: item.authorName,
        actor: 'sentinel',
        details: `Rule "${rule.name}" triggered: ${rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`).join(' AND ')}`,
        riskTier: item.riskTier,
      };
      await addAuditEntry(kv, subreddit, auditEntry);

      // Collect all actions from this rule
      for (const action of rule.actions) {
        actionRequests.push({ rule, action, item });
      }
    }
  }

  return actionRequests;
}

/**
 * Execute a single rule action. This is called from main.ts
 * after evaluateRules returns action requests.
 *
 * Some actions (remove, modmail) require the Reddit API context
 * and are handled by the caller. This function handles actions
 * that only need KV/Redis.
 *
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit name.
 * @param actionRequest - The action to execute.
 * @returns Whether this action requires Reddit API intervention.
 */
export async function executeKVAction(
  kv: KVStore,
  subreddit: string,
  actionRequest: RuleActionRequest
): Promise<{ requiresRedditAPI: boolean; apiAction?: string; payload?: string }> {
  const { action, item } = actionRequest;

  switch (action.type) {
    case 'remove':
      return { requiresRedditAPI: true, apiAction: 'remove' };

    case 'flair':
      return { requiresRedditAPI: true, apiAction: 'flair', payload: action.payload ?? '' };

    case 'watchlist':
      await addToWatchlist(kv, subreddit, {
        username: item.authorName,
        addedAt: Date.now(),
        addedBy: 'sentinel',
        reason: `Auto-added by rule: ${actionRequest.rule.name}`,
        violationCount: 1,
        note: action.payload ?? '',
      });
      return { requiresRedditAPI: false };

    case 'modmail':
      return { requiresRedditAPI: true, apiAction: 'modmail', payload: action.payload ?? '' };

    case 'stickyComment':
      return { requiresRedditAPI: true, apiAction: 'stickyComment', payload: action.payload ?? '' };

    case 'report':
      return { requiresRedditAPI: true, apiAction: 'report', payload: action.payload ?? '' };

    default:
      return { requiresRedditAPI: false };
  }
}

/**
 * Generate a unique rule ID.
 */
export function generateRuleId(): string {
  return `rule_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a default empty rule for the Rule Builder UI.
 */
export function createEmptyRule(createdBy: string): WorkflowRule {
  return {
    id: generateRuleId(),
    name: 'New Rule',
    enabled: false,
    priority: 100,
    conditions: [],
    actions: [],
    createdBy,
    triggerCount: 0,
  };
}
