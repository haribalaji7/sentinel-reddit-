/**
 * @fileoverview Multi-signal content risk classifier for Reddit Sentinel AI.
 *
 * The classifier evaluates three weighted signal dimensions:
 *   - Content Analysis (40%): toxicity, URLs, formatting abuse, sentiment
 *   - Author Profile (35%): account age, karma, removal history
 *   - Behavioral Pattern (25%): posting frequency, duplicates, first-post
 *
 * Each signal contributes risk points. Points are summed per dimension,
 * capped at 100, weighted, then combined into a final 0–100 risk score.
 * The score maps to a risk tier: CRITICAL / HIGH / MEDIUM / LOW / CLEAN.
 *
 * All classification is deterministic (no external AI calls) and fully
 * explainable — every matched signal is recorded with a human-readable reason.
 */

import type { RedisClient, KVStore } from '@devvit/public-api';
import type {
  ClassifierResult,
  RiskTier,
  SignalBreakdown,
  ContentType,
} from '../types/index.js';
import { RISK_THRESHOLDS } from '../types/index.js';
import {
  getRecentPostCount,
  getRecentCommentCount,
  isDuplicateContent,
  getRemovalCount,
} from '../storage/redisStore.js';
import { hasBeenRemoved } from '../storage/kvStore.js';

// ─────────────────────────────────────────────
// Toxicity Word Lists (tiered by severity)
// ─────────────────────────────────────────────

/** Words/phrases that indicate severe toxicity (hate speech, threats). */
const CRITICAL_KEYWORDS: string[] = [
  'kill yourself', 'kys', 'neck yourself', 'go die',
  'death threat', 'i will find you', 'i know where you live',
  'racial slur', 'n*gger', 'f*ggot',
  'swatting', 'doxxing', 'doxxed',
  'cp', 'child porn', 'csam',
];

/** Words indicating significant toxicity or harassment. */
const HIGH_KEYWORDS: string[] = [
  'retard', 'retarded', 'kill', 'murder', 'rape',
  'stfu', 'fck', 'fuk', 'die',
  'trash human', 'subhuman', 'worthless',
  'hang yourself', 'jump off',
  'terrorist', 'bomb threat',
];

/** Words indicating moderate toxicity or incivility. */
const MEDIUM_KEYWORDS: string[] = [
  'idiot', 'stupid', 'moron', 'dumb',
  'shut up', 'loser', 'pathetic',
  'disgusting', 'garbage', 'trash',
  'clown', 'cringe', 'cope',
  'seethe', 'ratio', 'nobody asked',
];

/** Known spam/scam patterns. */
const SPAM_PATTERNS: string[] = [
  'buy now', 'click here', 'limited time',
  'free money', 'make money fast', 'crypto opportunity',
  'dm me for', 'check my profile', 'link in bio',
  'onlyfans', 'follow me on', 'subscribe to my',
  'giveaway', 'airdrop', 'nft drop',
  'telegram', 'whatsapp group',
  'viagra', 'casino online',
  'earn from home', 'work from home opportunity',
];

/** Domains that are generally safe (not flagged for URL presence). */
const ALLOWED_DOMAINS: string[] = [
  'reddit.com', 'redd.it', 'imgur.com', 'i.imgur.com',
  'youtube.com', 'youtu.be', 'wikipedia.org',
  'twitter.com', 'x.com', 'github.com',
  'v.redd.it', 'preview.redd.it', 'i.redd.it',
  'google.com', 'bbc.com', 'cnn.com', 'nytimes.com',
  'reuters.com', 'apnews.com',
];

// ─────────────────────────────────────────────
// Content Analysis (Signal A — 40% weight)
// ─────────────────────────────────────────────

/**
 * Analyze content text for toxicity, spam patterns, and formatting abuse.
 * @returns Score 0–100 and list of matched signals.
 */
function analyzeContent(content: string): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  const lowerContent = content.toLowerCase();

  // ── Toxicity keyword matching ──
  for (const keyword of CRITICAL_KEYWORDS) {
    if (lowerContent.includes(keyword)) {
      score += 50;
      signals.push(`Critical toxicity: contains "${keyword}"`);
    }
  }
  for (const keyword of HIGH_KEYWORDS) {
    if (lowerContent.includes(keyword)) {
      score += 30;
      signals.push(`High toxicity: contains "${keyword}"`);
    }
  }
  for (const keyword of MEDIUM_KEYWORDS) {
    if (lowerContent.includes(keyword)) {
      score += 15;
      signals.push(`Moderate incivility: contains "${keyword}"`);
    }
  }

  // ── Spam pattern matching ──
  for (const pattern of SPAM_PATTERNS) {
    if (lowerContent.includes(pattern)) {
      score += 25;
      signals.push(`Spam pattern: "${pattern}"`);
    }
  }

  // ── ALL CAPS ratio ──
  const alphaChars = content.replace(/[^a-zA-Z]/g, '');
  if (alphaChars.length > 10) {
    const upperRatio = (content.replace(/[^A-Z]/g, '').length / alphaChars.length);
    if (upperRatio > 0.6) {
      score += 15;
      signals.push(`Excessive caps: ${Math.round(upperRatio * 100)}% uppercase`);
    }
  }

  // ── Excessive punctuation ──
  const exclamations = (content.match(/!{3,}/g) || []).length;
  const questions = (content.match(/\?{3,}/g) || []).length;
  if (exclamations + questions > 0) {
    score += 10;
    signals.push('Excessive punctuation detected');
  }

  // ── URL detection + domain check ──
  const urlPattern = /https?:\/\/([^\s/$.?#].[^\s]*)/gi;
  const urls = content.match(urlPattern) || [];
  for (const url of urls) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      const isAllowed = ALLOWED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
      if (!isAllowed) {
        score += 20;
        signals.push(`Unrecognized URL domain: ${domain}`);
      }
    } catch {
      score += 20;
      signals.push('Malformed URL detected');
    }
  }

  // ── Emoji spam (>10 emoji) ──
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const emojiCount = (content.match(emojiPattern) || []).length;
  if (emojiCount > 10) {
    score += 10;
    signals.push(`Emoji spam: ${emojiCount} emojis`);
  }

  // ── Very short content (potential spam/low effort) ──
  if (content.trim().length < 5 && content.trim().length > 0) {
    score += 5;
    signals.push('Very short content (possible low effort)');
  }

  return { score: Math.min(score, 100), signals };
}

// ─────────────────────────────────────────────
// Author Profile Analysis (Signal B — 35% weight)
// ─────────────────────────────────────────────

/** Input data about the content author for risk scoring. */
export interface AuthorProfile {
  accountAgeDays: number;
  postKarma: number;
  commentKarma: number;
  /** Whether the author has had content removed in this subreddit before. */
  previouslyRemoved: boolean;
}

/**
 * Score an author's profile for risk indicators.
 * New accounts with low karma are higher risk.
 */
function analyzeAuthor(profile: AuthorProfile): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  // Account age
  if (profile.accountAgeDays < 1) {
    score += 50;
    signals.push('Brand new account (< 1 day old)');
  } else if (profile.accountAgeDays < 7) {
    score += 30;
    signals.push(`New account (${profile.accountAgeDays} days old)`);
  } else if (profile.accountAgeDays < 30) {
    score += 10;
    signals.push(`Relatively new account (${profile.accountAgeDays} days)`);
  }

  // Post karma
  if (profile.postKarma < 10) {
    score += 20;
    signals.push(`Low post karma (${profile.postKarma})`);
  }

  // Comment karma (negative is very suspicious)
  if (profile.commentKarma < 0) {
    score += 25;
    signals.push(`Negative comment karma (${profile.commentKarma})`);
  } else if (profile.commentKarma < 10) {
    score += 10;
    signals.push(`Low comment karma (${profile.commentKarma})`);
  }

  // Prior removals in this sub
  if (profile.previouslyRemoved) {
    score += 30;
    signals.push('Previously had content removed in this subreddit');
  }

  return { score: Math.min(score, 100), signals };
}

// ─────────────────────────────────────────────
// Behavioral Pattern Analysis (Signal C — 25% weight)
// ─────────────────────────────────────────────

/** Input data about the author's recent behavior. */
export interface BehaviorProfile {
  /** Number of posts in the last 60 minutes. */
  recentPostCount: number;
  /** Number of comments in the last 10 minutes. */
  recentCommentCount: number;
  /** Whether this content is a duplicate of something seen recently. */
  isDuplicate: boolean;
  /** Whether this is the author's first post in this subreddit. */
  isFirstPost: boolean;
}

/**
 * Score behavioral patterns for anomalous activity.
 */
function analyzeBehavior(profile: BehaviorProfile): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  // High posting frequency
  if (profile.recentPostCount > 3) {
    score += 40;
    signals.push(`High post frequency: ${profile.recentPostCount} posts in last 60min`);
  }

  // High comment frequency
  if (profile.recentCommentCount > 5) {
    score += 35;
    signals.push(`High comment frequency: ${profile.recentCommentCount} comments in last 10min`);
  }

  // Duplicate content
  if (profile.isDuplicate) {
    score += 60;
    signals.push('Duplicate content detected (matches previous post hash)');
  }

  // First post in subreddit
  if (profile.isFirstPost) {
    score += 10;
    signals.push('First-time poster in this subreddit');
  }

  return { score: Math.min(score, 100), signals };
}

// ─────────────────────────────────────────────
// Risk Tier Mapping
// ─────────────────────────────────────────────

/**
 * Convert a 0–100 composite risk score to a risk tier label.
 */
export function scoreToTier(score: number): RiskTier {
  if (score >= RISK_THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (score >= RISK_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= RISK_THRESHOLDS.MEDIUM) return 'MEDIUM';
  if (score >= RISK_THRESHOLDS.LOW) return 'LOW';
  return 'CLEAN';
}

// ─────────────────────────────────────────────
// Confidence Score Calculation
// ─────────────────────────────────────────────

/**
 * Calculate a confidence score (0–100) based on how many signals
 * contributed to the risk score. More signals = higher confidence.
 */
function calculateConfidence(matchedSignals: string[], breakdown: SignalBreakdown): number {
  const signalCount = matchedSignals.length;

  // Base confidence from signal count
  let confidence = Math.min(signalCount * 15, 60);

  // Boost confidence if multiple dimensions contributed
  const dimensionsActive = [
    breakdown.contentScore > 0,
    breakdown.authorScore > 0,
    breakdown.behaviorScore > 0,
  ].filter(Boolean).length;

  confidence += dimensionsActive * 15;

  // Cap at 100
  return Math.min(confidence, 100);
}

// ─────────────────────────────────────────────
// Main Classifier Entry Point
// ─────────────────────────────────────────────

/**
 * Classify a piece of content by running all three signal dimensions.
 *
 * @param content - The full text of the post or comment.
 * @param contentType - Whether this is a 'post' or 'comment'.
 * @param authorProfile - Author metadata (karma, account age, etc.).
 * @param behaviorProfile - Recent behavioral data.
 * @returns ClassifierResult with risk score, tier, breakdown, and reasoning.
 *
 * @example
 * ```ts
 * const result = classify(
 *   "Buy crypto now! Limited time offer!!!",
 *   'post',
 *   { accountAgeDays: 2, postKarma: 1, commentKarma: 0, previouslyRemoved: false },
 *   { recentPostCount: 5, recentCommentCount: 0, isDuplicate: false, isFirstPost: true }
 * );
 * // result.riskTier === 'HIGH'
 * ```
 */
export function classify(
  content: string,
  _contentType: ContentType,
  authorProfile: AuthorProfile,
  behaviorProfile: BehaviorProfile
): ClassifierResult {
  // Run each signal dimension
  const contentResult = analyzeContent(content);
  const authorResult = analyzeAuthor(authorProfile);
  const behaviorResult = analyzeBehavior(behaviorProfile);

  // Weighted composite score
  const weightedScore = Math.round(
    contentResult.score * 0.4 +
    authorResult.score * 0.35 +
    behaviorResult.score * 0.25
  );

  // Clamp to 0–100
  const riskScore = Math.min(Math.max(weightedScore, 0), 100);
  const riskTier = scoreToTier(riskScore);

  // Combine all matched signals
  const matchedSignals = [
    ...contentResult.signals,
    ...authorResult.signals,
    ...behaviorResult.signals,
  ];

  const signalBreakdown: SignalBreakdown = {
    contentScore: contentResult.score,
    authorScore: authorResult.score,
    behaviorScore: behaviorResult.score,
  };

  const confidenceScore = calculateConfidence(matchedSignals, signalBreakdown);

  return {
    riskScore,
    riskTier,
    signalBreakdown,
    matchedSignals,
    confidenceScore,
  };
}

// ─────────────────────────────────────────────
// Full Classification Pipeline (with storage lookups)
// ─────────────────────────────────────────────

/**
 * Run the full classification pipeline including Redis/KV lookups
 * for author history and behavioral patterns.
 *
 * This is the primary entry point used by triggers in main.ts.
 *
 * @param redis - Devvit Redis client.
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit name.
 * @param content - Full text of the post/comment.
 * @param contentType - Whether this is a 'post' or 'comment'.
 * @param authorName - Reddit username of the author.
 * @param accountAgeDays - Account age in days.
 * @param postKarma - Author's post karma.
 * @param commentKarma - Author's comment karma.
 */
export async function classifyWithContext(
  redis: RedisClient,
  kv: KVStore,
  subreddit: string,
  content: string,
  contentType: ContentType,
  authorName: string,
  accountAgeDays: number,
  postKarma: number,
  commentKarma: number
): Promise<ClassifierResult> {
  // Gather behavioral data from Redis
  const [recentPostCount, recentCommentCount, isDuplicate, previouslyRemoved] = await Promise.all([
    getRecentPostCount(redis, subreddit, authorName, 60),
    getRecentCommentCount(redis, subreddit, authorName, 10),
    isDuplicateContent(redis, subreddit, content),
    hasBeenRemoved(kv, subreddit, authorName),
  ]);

  // Determine if first post (if no recent activity recorded)
  const totalRecent = recentPostCount + recentCommentCount;
  const isFirstPost = totalRecent === 0;

  const authorProfile: AuthorProfile = {
    accountAgeDays,
    postKarma,
    commentKarma,
    previouslyRemoved,
  };

  const behaviorProfile: BehaviorProfile = {
    recentPostCount,
    recentCommentCount,
    isDuplicate,
    isFirstPost,
  };

  return classify(content, contentType, authorProfile, behaviorProfile);
}
