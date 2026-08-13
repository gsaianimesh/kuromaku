import "server-only";

/**
 * Token-per-minute pacing for providers that publish rate-limit headers.
 *
 * Groq's free tier caps some models at 8,000 tokens per minute, which a single
 * compiler stage can consume outright. Without pacing the second stage fails
 * with a 429 and the whole compile retries from scratch — so the limiter reads
 * what the provider reports and waits rather than guessing at a fixed delay.
 */

type Budget = {
  remainingTokens: number | null;
  /** Epoch ms when the token bucket refills. */
  resetAt: number | null;
  limitTokens: number | null;
};

const budgets = new Map<string, Budget>();

/** Groq reports durations as "7.66s", "1m30s", "2m59.56s". */
export function parseResetDuration(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match) {
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) ? asNumber * 1000 : null;
  }
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = match[2] ? Number(match[2]) : 0;
  const ms = (minutes * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

export function recordLimits(model: string, headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining-tokens");
  const reset = headers.get("x-ratelimit-reset-tokens");
  const limit = headers.get("x-ratelimit-limit-tokens");
  const resetMs = parseResetDuration(reset);

  budgets.set(model, {
    remainingTokens: remaining === null ? null : Number(remaining),
    resetAt: resetMs === null ? null : Date.now() + resetMs,
    limitTokens: limit === null ? null : Number(limit),
  });
}

/** Rough but adequate: English prose averages close to four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Waits until the model's token bucket can cover `needed`. Returns how long it
 * waited so the caller can report the delay rather than appearing to hang.
 */
export async function waitForBudget(
  model: string,
  needed: number,
  onWait?: (ms: number) => void,
): Promise<number> {
  const budget = budgets.get(model);
  if (!budget || budget.remainingTokens === null || budget.resetAt === null) {
    return 0;
  }
  if (budget.remainingTokens >= needed) return 0;

  // A little past the reset, so a clock skew of a few hundred ms is harmless.
  const waitMs = Math.max(0, budget.resetAt - Date.now()) + 500;
  if (waitMs <= 0) return 0;

  onWait?.(waitMs);
  await new Promise((r) => setTimeout(r, waitMs));
  budgets.delete(model);
  return waitMs;
}

export function knownLimit(model: string): number | null {
  return budgets.get(model)?.limitTokens ?? null;
}
