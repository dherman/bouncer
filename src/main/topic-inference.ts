/**
 * Topic inference for workspace sidebar labels.
 *
 * Primary: Create a second ACP session on the existing agent connection
 * and ask it to summarize the user's task in 3-5 words.
 * Fallback: Extract a topic heuristically from the first user message.
 */

export const TOPIC_PROMPT = `Summarize this task request in 3-5 words for use as a sidebar label in a coding workspace manager. Output ONLY the label, nothing else. No quotes, no punctuation, no explanation. Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → Fix auth token expiry
- "Can you add pagination to the /api/users endpoint?" → Add users pagination
- "Refactor the database connection pool" → Refactor DB conn pool
- "Write tests for the payment service" → Payment service tests

Task: `;

const MAX_TOPIC_LENGTH = 30;

/** Truncate text to MAX_TOPIC_LENGTH at a word boundary. */
export function truncateTopic(text: string): string {
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
export function inferTopicHeuristic(message: string): string | null {
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
