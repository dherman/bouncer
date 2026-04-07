/**
 * Lightweight topic inference via Anthropic Messages API (Haiku).
 * Used to generate short sidebar labels from the first user prompt.
 */

const TOPIC_PROMPT = `Summarize this task request in 3-5 words for use as a sidebar label in a coding workspace manager. Output ONLY the label, nothing else. Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → "Fix auth token expiry"
- "Can you add pagination to the /api/users endpoint?" → "Add users pagination"
- "Refactor the database connection pool" → "Refactor DB conn pool"
- "Write tests for the payment service" → "Payment service tests"

Task: `;

/**
 * Infer a short topic label from a user message using Claude Haiku.
 * Returns null on any failure (missing key, timeout, API error) — callers
 * should treat this as best-effort and keep the existing label.
 */
export async function inferTopic(userMessage: string): Promise<string | null> {
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

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.type === 'text' ? data.content[0].text?.trim() : null;
    if (!text) return null;

    // Enforce 30-char limit
    if (text.length <= 30) return text;
    const lastSpace = text.slice(0, 30).lastIndexOf(' ');
    return lastSpace > 10 ? text.slice(0, lastSpace) : text.slice(0, 30);
  } catch {
    return null; // Timeout, network error, etc. — fail silently
  }
}
