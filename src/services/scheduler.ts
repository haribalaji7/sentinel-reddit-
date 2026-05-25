/**
 * @fileoverview Scheduled intelligence service for Reddit Sentinel AI.
 *
 * Runs on a Devvit Scheduler cron job (every 5 minutes) to:
 * 1. Detect activity spikes (spam waves)
 * 2. Update the community health score
 * 3. Clean up expired Redis entries
 * 4. Send modmail alerts on critical spikes
 */

import type { RedisClient, KVStore } from '@devvit/public-api';
import type { AuditLogEntry } from '../types/index.js';
import { getHourlyVolume } from '../storage/redisStore.js';
import { addAuditEntry } from '../storage/kvStore.js';
import { updateHealthScore } from './analytics.js';

// ─────────────────────────────────────────────
// Spike Detection
// ─────────────────────────────────────────────

/** Multiplier above baseline that triggers a spike alert. */
const SPIKE_THRESHOLD_MULTIPLIER = 10;

/** Minimum absolute volume to consider a spike (prevents false alarms on tiny subs). */
const MINIMUM_SPIKE_VOLUME = 5;

/** Result of a spike detection check. */
export interface SpikeCheckResult {
  /** Whether a spike was detected. */
  isSpike: boolean;
  /** Current hour's volume. */
  currentVolume: number;
  /** Rolling average hourly volume (baseline). */
  baselineVolume: number;
  /** Multiplier above baseline. */
  multiplier: number;
  /** Human-readable message. */
  message: string;
}

/**
 * Check if there's an activity spike in the current hour
 * compared to the rolling 24-hour average.
 *
 * A spike is defined as current volume > baseline × SPIKE_THRESHOLD_MULTIPLIER
 * and current volume > MINIMUM_SPIKE_VOLUME.
 *
 * @param redis - Devvit Redis client.
 * @param subreddit - Subreddit to check.
 * @returns Spike check result with diagnosis.
 */
export async function detectSpike(
  redis: RedisClient,
  subreddit: string
): Promise<SpikeCheckResult> {
  const now = new Date();
  const currentHourKey = now.toISOString().slice(0, 13);
  const currentVolume = await getHourlyVolume(redis, subreddit, currentHourKey);

  // Calculate baseline from previous 24 hours (excluding current hour)
  let totalBaseline = 0;
  let hoursChecked = 0;

  for (let i = 1; i <= 24; i++) {
    const pastHour = new Date(now.getTime() - i * 60 * 60 * 1000);
    const hourKey = pastHour.toISOString().slice(0, 13);
    const vol = await getHourlyVolume(redis, subreddit, hourKey);
    totalBaseline += vol;
    hoursChecked++;
  }

  const baselineVolume = hoursChecked > 0 ? totalBaseline / hoursChecked : 0;
  const multiplier = baselineVolume > 0 ? currentVolume / baselineVolume : 0;

  const isSpike = currentVolume >= MINIMUM_SPIKE_VOLUME &&
    multiplier >= SPIKE_THRESHOLD_MULTIPLIER;

  const message = isSpike
    ? `🚨 Activity spike detected: ${currentVolume} items this hour vs ${Math.round(baselineVolume)} avg (${Math.round(multiplier)}x above normal)`
    : `Normal activity: ${currentVolume} items this hour (baseline: ${Math.round(baselineVolume)})`;

  return {
    isSpike,
    currentVolume,
    baselineVolume: Math.round(baselineVolume),
    multiplier: Math.round(multiplier * 10) / 10,
    message,
  };
}

// ─────────────────────────────────────────────
// Main Scheduler Entry Point
// ─────────────────────────────────────────────

/**
 * Main function called by the Devvit scheduler every 5 minutes.
 * Orchestrates spike detection, health score updates, and cleanup.
 *
 * @param redis - Devvit Redis client.
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit to process.
 * @returns Object with spike result and updated health score.
 */
export async function runScheduledIntelligence(
  redis: RedisClient,
  kv: KVStore,
  subreddit: string
): Promise<{
  spikeResult: SpikeCheckResult;
  healthScore: number;
  shouldAlert: boolean;
}> {
  // 1. Check for activity spikes
  const spikeResult = await detectSpike(redis, subreddit);

  if (spikeResult.isSpike) {
    // Log spike to audit
    const auditEntry: AuditLogEntry = {
      id: `audit_spike_${Date.now()}`,
      timestamp: Date.now(),
      actionType: 'spike_alert',
      actor: 'sentinel',
      details: spikeResult.message,
    };
    await addAuditEntry(kv, subreddit, auditEntry);
  }

  // 2. Update community health score
  const healthScore = await updateHealthScore(redis, kv, subreddit);

  // 3. No explicit cleanup needed — Redis TTLs handle expiration automatically

  return {
    spikeResult,
    healthScore,
    shouldAlert: spikeResult.isSpike,
  };
}

/**
 * Generate modmail alert body for a spike event.
 *
 * @param subreddit - Subreddit name.
 * @param spikeResult - Spike detection result.
 * @returns Formatted modmail body string.
 */
export function formatSpikeAlert(subreddit: string, spikeResult: SpikeCheckResult): string {
  return [
    `🚨 **Sentinel AI: Activity Spike Detected in r/${subreddit}**`,
    '',
    `**Current Volume:** ${spikeResult.currentVolume} items this hour`,
    `**Baseline Average:** ${spikeResult.baselineVolume} items/hour`,
    `**Spike Multiplier:** ${spikeResult.multiplier}x above normal`,
    '',
    'This may indicate a spam wave or brigade. Please check the Sentinel Dashboard for details.',
    '',
    '---',
    '*This alert was generated automatically by Reddit Sentinel AI.*',
  ].join('\n');
}
