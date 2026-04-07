/**
 * Lightweight topic inference via Anthropic Messages API (Haiku).
 * Used to generate short sidebar labels from the first user prompt.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

const TOPIC_PROMPT = `Summarize this task request in 3-5 words for use as a sidebar label in a coding workspace manager. Output ONLY the label, nothing else. Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → "Fix auth token expiry"
- "Can you add pagination to the /api/users endpoint?" → "Add users pagination"
- "Refactor the database connection pool" → "Refactor DB conn pool"
- "Write tests for the payment service" → "Payment service tests"

Task: `;

/** Cached auth header to avoid repeated keychain lookups. */
let cachedAuth: { header: string; expiresAt: number } | null = null;

/**
 * Get auth credentials for the Anthropic API.
 * Tries ANTHROPIC_API_KEY first, then falls back to macOS keychain OAuth token.
 */
async function getAuthHeader(): Promise<{ key: string; value: string } | null> {
  // Prefer explicit API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return { key: 'x-api-key', value: apiKey };
  }

  // Check cached OAuth token
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
    return { key: 'Authorization', value: cachedAuth.header };
  }

  // Extract from macOS keychain
  if (process.platform !== 'darwin') return null;

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
    const creds = JSON.parse(stdout.trim());
    const accessToken = creds?.claudeAiOauth?.accessToken;
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (!accessToken) {
      console.warn('[topic] Keychain credentials missing accessToken');
      return null;
    }
    const header = `Bearer ${accessToken}`;
    // Cache until token expires (with 60s buffer), or 5 minutes if no expiry
    cachedAuth = {
      header,
      expiresAt: expiresAt ? expiresAt - 60_000 : Date.now() + 5 * 60_000,
    };
    return { key: 'Authorization', value: header };
  } catch (err) {
    console.warn('[topic] Could not extract credentials from keychain:', err);
    return null;
  }
}

/**
 * Infer a short topic label from a user message using Claude Haiku.
 * Returns null on any failure (missing key, timeout, API error) — callers
 * should treat this as best-effort and keep the existing label.
 */
export async function inferTopic(userMessage: string): Promise<string | null> {
  const auth = await getAuthHeader();
  if (!auth) {
    console.log('[topic] No API credentials available — skipping topic inference');
    return null;
  }

  const truncatedMessage = userMessage.slice(0, 500);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [auth.key]: auth.value,
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
      // Clear cached auth on auth failure so next attempt re-reads keychain
      if (resp.status === 401 || resp.status === 403) cachedAuth = null;
      return null;
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.type === 'text' ? data.content[0].text?.trim() : null;
    if (!text) return null;

    // Enforce 30-char limit
    if (text.length <= 30) {
      console.log(`[topic] Inferred: "${text}"`);
      return text;
    }
    const lastSpace = text.slice(0, 30).lastIndexOf(' ');
    const truncated = lastSpace > 10 ? text.slice(0, lastSpace) : text.slice(0, 30);
    console.log(`[topic] Inferred (truncated): "${truncated}"`);
    return truncated;
  } catch (err) {
    console.warn('[topic] Inference failed:', err);
    return null;
  }
}
