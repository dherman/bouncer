/**
 * Lightweight topic inference for workspace sidebar labels.
 *
 * Strategy:
 * 1. If ANTHROPIC_API_KEY is set, use Haiku for high-quality 3-5 word summaries
 * 2. Otherwise, extract a topic heuristically from the first user message
 */

const TOPIC_PROMPT = `Summarize this task request in 3-5 words for use as a sidebar label in a coding workspace manager. Output ONLY the label, nothing else. Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → "Fix auth token expiry"
- "Can you add pagination to the /api/users endpoint?" → "Add users pagination"
- "Refactor the database connection pool" → "Refactor DB conn pool"
- "Write tests for the payment service" → "Payment service tests"

Task: `;

const MAX_TOPIC_LENGTH = 30;

/** Truncate text to MAX_TOPIC_LENGTH at a word boundary. */
function truncateTopic(text: string): string {
  if (text.length <= MAX_TOPIC_LENGTH) return text;
  const truncated = text.slice(0, MAX_TOPIC_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Extract a topic heuristically from the user's message.
 * Takes the first sentence/line (whichever is shorter), strips filler,
 * and truncates to fit the sidebar.
 */
function heuristicTopic(message: string): string | null {
  // Take the first line
  let text = message.split('\n')[0].trim();
  if (!text) return null;

  // Strip common conversational prefixes
  text = text.replace(
    /^(hey,?\s+|hi,?\s+|please\s+|can you\s+|could you\s+|i need you to\s+|i'd like you to\s+|let's\s+)/i,
    '',
  );

  // Take up to the first sentence-ending punctuation
  const sentenceEnd = text.search(/[.!?]/);
  if (sentenceEnd > 0) {
    text = text.slice(0, sentenceEnd);
  }

  text = text.trim();
  if (!text || text.length < 3) return null;

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  return truncateTopic(text);
}

/**
 * Try Haiku API for topic inference (requires ANTHROPIC_API_KEY).
 */
async function inferTopicViaApi(userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const truncatedMessage = userMessage.slice(0, 500);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: TOPIC_PROMPT + truncatedMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[topic] API returned ${resp.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.type === 'text' ? data.content[0].text?.trim() : null;
    if (!text) return null;

    console.log(`[topic] Haiku inferred: "${text}"`);
    return truncateTopic(text);
  } catch (err) {
    console.warn('[topic] API inference failed:', err);
    return null;
  }
}

/**
 * Infer a short topic label from a user message.
 * Tries Haiku API first, falls back to heuristic extraction.
 */
export async function inferTopic(userMessage: string): Promise<string | null> {
  // Try LLM inference if API key is available
  const apiResult = await inferTopicViaApi(userMessage);
  if (apiResult) return apiResult;

  // Fall back to heuristic extraction
  const heuristic = heuristicTopic(userMessage);
  if (heuristic) {
    console.log(`[topic] Heuristic: "${heuristic}"`);
  }
  return heuristic;
}
