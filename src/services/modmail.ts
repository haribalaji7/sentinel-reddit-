/**
 * @fileoverview Modmail assistant service for Reddit Sentinel AI.
 *
 * Provides template-based response drafting for common modmail
 * categories. Detects modmail category via keyword analysis and
 * generates pre-filled responses using stored templates.
 */

import type { KVStore } from '@devvit/public-api';
import type { ModmailCategory, ModmailTemplate } from '../types/index.js';
import { getTemplates } from '../storage/kvStore.js';

// ─────────────────────────────────────────────
// Category Detection Keywords
// ─────────────────────────────────────────────

/** Keyword sets for detecting modmail categories. */
const CATEGORY_KEYWORDS: Record<ModmailCategory, string[]> = {
  ban_appeal: [
    'ban', 'banned', 'unban', 'appeal', 'unfair',
    'reconsider', 'mistake', 'second chance', 'permanent ban',
    'temporary ban', 'why was i banned', 'lift my ban',
    'wrongfully', 'unjust',
  ],
  spam_report: [
    'spam', 'spammer', 'bot', 'scam', 'phishing',
    'fake', 'advertisement', 'advertising', 'self-promotion',
    'promotional', 'selling', 'buy now',
  ],
  rule_question: [
    'rule', 'rules', 'allowed', 'allow', 'guideline',
    'policy', 'can i post', 'is it okay', 'am i allowed',
    'what is the rule', 'clarify', 'clarification',
    'which rule', 'against the rules',
  ],
  harassment: [
    'harass', 'harassment', 'bully', 'bullying', 'threat',
    'threatening', 'stalking', 'doxxing', 'doxxed',
    'abusive', 'abuse', 'attacked', 'hate',
    'targeted', 'intimidation',
  ],
  general: [], // Fallback category
};

// ─────────────────────────────────────────────
// Category Detection
// ─────────────────────────────────────────────

/**
 * Detect the most likely category of a modmail message.
 * Uses keyword matching with scoring — category with the most
 * keyword matches wins. Falls back to 'general' if no matches.
 *
 * @param subject - The modmail subject line.
 * @param body - The modmail body text.
 * @returns The detected category.
 */
export function detectCategory(subject: string, body: string): ModmailCategory {
  const text = `${subject} ${body}`.toLowerCase();

  let bestCategory: ModmailCategory = 'general';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === 'general') continue;

    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        score++;
        // Subject matches are worth 2x
        if (subject.toLowerCase().includes(keyword)) {
          score++;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as ModmailCategory;
    }
  }

  return bestCategory;
}

// ─────────────────────────────────────────────
// Sentiment Analysis (Simple Rule-Based)
// ─────────────────────────────────────────────

/** Sentiment polarity result. */
export interface SentimentResult {
  /** Polarity score: -1 (very negative) to +1 (very positive). */
  polarity: number;
  /** Human-readable label. */
  label: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';
}

/** Positive sentiment words. */
const POSITIVE_WORDS = [
  'thank', 'thanks', 'appreciate', 'grateful', 'please',
  'help', 'understand', 'great', 'good', 'love',
  'excellent', 'wonderful', 'amazing', 'happy', 'kind',
  'fair', 'reasonable', 'polite', 'respectful',
];

/** Negative sentiment words. */
const NEGATIVE_WORDS = [
  'angry', 'furious', 'hate', 'terrible', 'awful',
  'worst', 'horrible', 'disgusting', 'unfair', 'biased',
  'corrupt', 'power trip', 'abuse', 'nazi', 'fascist',
  'incompetent', 'useless', 'pathetic', 'joke',
  'ridiculous', 'outrageous', 'shameful',
];

/**
 * Analyze sentiment of a modmail message.
 * Simple rule-based approach using positive/negative word counts.
 *
 * @param text - The text to analyze.
 * @returns Sentiment polarity and label.
 */
export function analyzeSentiment(text: string): SentimentResult {
  const lower = text.toLowerCase();
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of POSITIVE_WORDS) {
    if (lower.includes(word)) positiveCount++;
  }
  for (const word of NEGATIVE_WORDS) {
    if (lower.includes(word)) negativeCount++;
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return { polarity: 0, label: 'neutral' };

  const polarity = (positiveCount - negativeCount) / total;

  let label: SentimentResult['label'];
  if (polarity <= -0.6) label = 'very_negative';
  else if (polarity <= -0.2) label = 'negative';
  else if (polarity < 0.2) label = 'neutral';
  else if (polarity < 0.6) label = 'positive';
  else label = 'very_positive';

  return { polarity: Math.round(polarity * 100) / 100, label };
}

// ─────────────────────────────────────────────
// Draft Generation
// ─────────────────────────────────────────────

/**
 * Generate a draft response for a modmail message.
 *
 * 1. Detects the category of the incoming modmail.
 * 2. Finds the best matching template.
 * 3. Fills in known variables.
 *
 * @param kv - Devvit KV Store client.
 * @param subreddit - Subreddit name.
 * @param senderName - Username of the modmail sender.
 * @param subject - Modmail subject.
 * @param body - Modmail body.
 * @returns Draft response with category and sentiment analysis.
 */
export async function generateDraft(
  kv: KVStore,
  subreddit: string,
  senderName: string,
  subject: string,
  body: string
): Promise<{
  category: ModmailCategory;
  sentiment: SentimentResult;
  draft: string;
  draftSubject: string;
  templateUsed: string;
}> {
  // Detect category
  const category = detectCategory(subject, body);

  // Analyze sentiment
  const sentiment = analyzeSentiment(`${subject} ${body}`);

  // Get templates
  const templates = await getTemplates(kv, subreddit);
  const matchingTemplate = templates.find((t) => t.category === category)
    || templates.find((t) => t.category === 'general')
    || null;

  if (!matchingTemplate) {
    return {
      category,
      sentiment,
      draft: `Hi ${senderName},\n\nThank you for contacting the r/${subreddit} mod team. We have received your message and will review it shortly.\n\n— r/${subreddit} Mod Team`,
      draftSubject: `Re: ${subject}`,
      templateUsed: 'default',
    };
  }

  // Fill in template variables
  let draft = matchingTemplate.body;
  draft = draft.replace(/\{\{username\}\}/g, senderName);
  draft = draft.replace(/\{\{subreddit\}\}/g, subreddit);
  // Leave unfilled variables as placeholders for the mod to fill
  draft = draft.replace(/\{\{(\w+)\}\}/g, '[FILL: $1]');

  let draftSubject = matchingTemplate.subject;
  draftSubject = draftSubject.replace(/\{\{subreddit\}\}/g, subreddit);

  return {
    category,
    sentiment,
    draft,
    draftSubject,
    templateUsed: matchingTemplate.name,
  };
}
