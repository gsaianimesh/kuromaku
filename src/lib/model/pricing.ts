import "server-only";

/**
 * USD per million tokens. SPEC section 4 forbids fabricated numbers, so a model
 * absent from this table yields a null cost rather than zero — the UI then says
 * "unpriced" instead of implying the call was free.
 *
 * Verified against published rate cards on 2026-08-13. Re-check when adding a
 * model; a stale price is a wrong number, which is the thing we are avoiding.
 */
export type Price = { inputPerMTok: number; outputPerMTok: number };

export const PRICING: Record<string, Price> = {
  // Anthropic
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },

  // Groq
  "llama-3.3-70b-versatile": { inputPerMTok: 0.59, outputPerMTok: 0.79 },
  "llama-3.1-8b-instant": { inputPerMTok: 0.05, outputPerMTok: 0.08 },
  "openai/gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.75 },
  "openai/gpt-oss-20b": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "moonshotai/kimi-k2-instruct": { inputPerMTok: 1.0, outputPerMTok: 3.0 },
};

export function costOf(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const price = PRICING[model];
  if (!price || inputTokens === null || outputTokens === null) return null;
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}

export function isPriced(model: string): boolean {
  return model in PRICING;
}
