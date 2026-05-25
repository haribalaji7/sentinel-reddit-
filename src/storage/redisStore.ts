/**
 * @fileoverview Typed wrappers for Devvit Redis operations.
 * Provides namespaced, type-safe access to Redis for real-time
 * queue management, activity tracking, and deduplication.
 */

import type { RedisClient } from '@devvit/public-api';
import type { SentinelItem, AuditLogEntry, WatchlistEntry } from '../types/index.js';
import { REDIS_KEYS, TTL } from '../types/index.js';

// ─────────────────────────────────────────────
// Queue Operations
// ─────────────────────────────────────────────

/**
 * Add a flagged item to the priority queue (sorted set by risk score).
 * Higher risk scores surface first in the mod queue.
 */
export async function addToQueue(
  redis: RedisClient,
  subreddit: string,
  item: SentinelItem
): Promise<void> {
  const queueKey = `${REDIS_KEYS.QUEUE}:${subreddit}`;
  const itemKey = `${REDIS_KEYS.ITEM}:${subreddit}:${item.id}`;

  // Store full item data
  await redis.set(itemKey, JSON.stringify(item));
  await redis.expire(itemKey, TTL.ITEM);

  // Add to sorted set (score = riskScore for priority ordering)
  await redis.zAdd(queueKey, { member: item.id, score: item.riskScore });
}

/**
 * Retrieve all pending items from the queue, ordered by risk score descending.
 * Returns items with status 'pending' only.
 * @param limit - Maximum number of items to return (default 50).
 */
export async function getQueue(
  redis: RedisClient,
  subreddit: string,
  limit: number = 50
): Promise<SentinelItem[]> {
  const queueKey = `${REDIS_KEYS.QUEUE}:${subreddit}`;

  // Get IDs sorted by score descending (highest risk first)
  const members = await redis.zRange(queueKey, 0, limit - 1, { by: 'rank', reverse: true });
  if (!members || members.length === 0) return [];

  const items: SentinelItem[] = [];
  for (const entry of members) {
    const memberId = typeof entry === 'string' ? entry : entry.member;
    const itemKey = `${REDIS_KEYS.ITEM}:${subreddit}:${memberId}`;
    const raw = await redis.get(itemKey);
    if (raw) {
      try {
        const item = JSON.parse(raw) as SentinelItem;
        items.push(item);
      } catch {
        // Corrupted entry, skip
      }
    }
  }

  return items;
}

/**
 * Get a single flagged item by ID.
 */
export async function getItem(
  redis: RedisClient,
  subreddit: string,
  itemId: string
): Promise<SentinelItem | null> {
  const itemKey = `${REDIS_KEYS.ITEM}:${subreddit}:${itemId}`;
  const raw = await redis.get(itemKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SentinelItem;
  } catch {
    return null;
  }
}

/**
 * Update an item's status after a mod action.
 * Also removes from the active queue sorted set.
 */
export async function updateItemStatus(
  redis: RedisClient,
  subreddit: string,
  itemId: string,
  status: SentinelItem['status'],
  reviewedBy: string,
  isModOverride: boolean = false
): Promise<SentinelItem | null> {
  const item = await getItem(redis, subreddit, itemId);
  if (!item) return null;

  item.status = status;
  item.reviewedBy = reviewedBy;
  item.reviewedAt = Date.now();
  item.isModOverride = isModOverride;

  const itemKey = `${REDIS_KEYS.ITEM}:${subreddit}:${itemId}`;
  await redis.set(itemKey, JSON.stringify(item));

  // Remove from active queue if actioned
  if (status !== 'pending') {
    const queueKey = `${REDIS_KEYS.QUEUE}:${subreddit}`;
    await redis.zRem(queueKey, [itemId]);
  }

  return item;
}

// ─────────────────────────────────────────────
// Activity Tracking (for behavioral signals)
// ─────────────────────────────────────────────

/**
 * Record a user's posting activity for rate-based behavioral signals.
 * Uses a Redis sorted set with timestamps as scores.
 */
export async function recordActivity(
  redis: RedisClient,
  subreddit: string,
  author: string,
  contentType: 'post' | 'comment'
): Promise<void> {
  const key = `${REDIS_KEYS.ACTIVITY}:${subreddit}:${author}`;
  const now = Date.now();
  await redis.zAdd(key, { member: `${contentType}:${now}`, score: now });
  await redis.expire(key, TTL.ACTIVITY);
}

/**
 * Count a user's posts in the last N minutes.
 */
export async function getRecentActivityCount(
  redis: RedisClient,
  subreddit: string,
  author: string,
  minutesBack: number
): Promise<number> {
  const key = `${REDIS_KEYS.ACTIVITY}:${subreddit}:${author}`;
  const now = Date.now();
  const since = now - minutesBack * 60 * 1000;

  const entries = await redis.zRange(key, since, now, { by: 'score' });
  return entries ? entries.length : 0;
}

/**
 * Count only posts (not comments) in the last N minutes.
 */
export async function getRecentPostCount(
  redis: RedisClient,
  subreddit: string,
  author: string,
  minutesBack: number
): Promise<number> {
  const key = `${REDIS_KEYS.ACTIVITY}:${subreddit}:${author}`;
  const now = Date.now();
  const since = now - minutesBack * 60 * 1000;

  const entries = await redis.zRange(key, since, now, { by: 'score' });
  if (!entries) return 0;

  return entries.filter((e) => {
    const member = typeof e === 'string' ? e : e.member;
    return member.startsWith('post:');
  }).length;
}

/**
 * Count only comments in the last N minutes.
 */
export async function getRecentCommentCount(
  redis: RedisClient,
  subreddit: string,
  author: string,
  minutesBack: number
): Promise<number> {
  const key = `${REDIS_KEYS.ACTIVITY}:${subreddit}:${author}`;
  const now = Date.now();
  const since = now - minutesBack * 60 * 1000;

  const entries = await redis.zRange(key, since, now, { by: 'score' });
  if (!entries) return 0;

  return entries.filter((e) => {
    const member = typeof e === 'string' ? e : e.member;
    return member.startsWith('comment:');
  }).length;
}

// ─────────────────────────────────────────────
// Content Deduplication
// ─────────────────────────────────────────────

/**
 * Generate a simple hash of content for duplicate detection.
 * Normalizes: lowercases, strips extra whitespace and punctuation.
 */
export function hashContent(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Check if content has been seen before. If not, record its hash.
 * @returns true if the content is a duplicate.
 */
export async function isDuplicateContent(
  redis: RedisClient,
  subreddit: string,
  content: string
): Promise<boolean> {
  const hash = hashContent(content);
  const key = `${REDIS_KEYS.CONTENT_HASH}:${subreddit}:${hash}`;

  const existing = await redis.get(key);
  if (existing) return true;

  // Not a duplicate — record it
  await redis.set(key, Date.now().toString());
  await redis.expire(key, TTL.CONTENT_HASH);
  return false;
}

// ─────────────────────────────────────────────
// Volume Tracking (for spike detection)
// ─────────────────────────────────────────────

/**
 * Increment the hourly content volume counter.
 */
export async function incrementHourlyVolume(
  redis: RedisClient,
  subreddit: string
): Promise<void> {
  const hour = new Date().toISOString().slice(0, 13); // "2024-01-15T08"
  const key = `${REDIS_KEYS.HOURLY}:${subreddit}:${hour}`;

  const current = await redis.get(key);
  await redis.set(key, String((parseInt(current || '0', 10) || 0) + 1));
  await redis.expire(key, TTL.HOURLY);
}

/**
 * Get volume for a specific hour.
 */
export async function getHourlyVolume(
  redis: RedisClient,
  subreddit: string,
  hourKey: string
): Promise<number> {
  const key = `${REDIS_KEYS.HOURLY}:${subreddit}:${hourKey}`;
  const val = await redis.get(key);
  return parseInt(val || '0', 10) || 0;
}

/**
 * Increment daily volume counter (for analytics charts).
 */
export async function incrementDailyVolume(
  redis: RedisClient,
  subreddit: string
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // "2024-01-15"
  const key = `${REDIS_KEYS.VOLUME}:${subreddit}:${date}`;

  const current = await redis.get(key);
  await redis.set(key, String((parseInt(current || '0', 10) || 0) + 1));
  // Daily counters persist for 90 days
  await redis.expire(key, 90 * 24 * 60 * 60);
}

// ─────────────────────────────────────────────
// Author Removal History
// ─────────────────────────────────────────────

/**
 * Record that an author's content was removed in this subreddit.
 */
export async function recordRemoval(
  redis: RedisClient,
  subreddit: string,
  author: string
): Promise<void> {
  const key = `${REDIS_KEYS.REMOVALS}:${subreddit}:${author}`;
  const current = await redis.get(key);
  await redis.set(key, String((parseInt(current || '0', 10) || 0) + 1));
  // Track removal history for 30 days
  await redis.expire(key, 30 * 24 * 60 * 60);
}

/**
 * Get number of prior removals for an author in this subreddit.
 */
export async function getRemovalCount(
  redis: RedisClient,
  subreddit: string,
  author: string
): Promise<number> {
  const key = `${REDIS_KEYS.REMOVALS}:${subreddit}:${author}`;
  const val = await redis.get(key);
  return parseInt(val || '0', 10) || 0;
}

// ─────────────────────────────────────────────
// Response Time Tracking
// ─────────────────────────────────────────────

/**
 * Record a response time (ms between flag and action).
 */
export async function recordResponseTime(
  redis: RedisClient,
  subreddit: string,
  responseTimeMs: number
): Promise<void> {
  const key = `${REDIS_KEYS.RESPONSE_TIME}:${subreddit}`;
  await redis.zAdd(key, { member: `${Date.now()}`, score: responseTimeMs });
}

/**
 * Get average response time over recent entries.
 */
export async function getAverageResponseTime(
  redis: RedisClient,
  subreddit: string,
  limit: number = 100
): Promise<number> {
  const key = `${REDIS_KEYS.RESPONSE_TIME}:${subreddit}`;
  const entries = await redis.zRange(key, 0, limit - 1, { by: 'rank', reverse: true });
  if (!entries || entries.length === 0) return 0;

  let total = 0;
  for (const entry of entries) {
    const score = typeof entry === 'string' ? 0 : entry.score;
    total += score;
  }
  return Math.round(total / entries.length);
}
