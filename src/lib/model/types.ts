import "server-only";

/**
 * One seam for every model call (SPEC section 5). Providers differ in wire
 * format; everything above this interface sees the same shape, including the
 * token counts and cost that section 4 requires be logged for every call.
 */

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ModelRequest = {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Ask the provider for JSON. Validation is still ours to do (SPEC 7.2). */
  jsonMode?: boolean;
  /** Surfaces rate-limit waits to the job log so a pause never looks like a hang. */
  onWait?: (message: string) => void;
};

export type ModelResponse = {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Null when the model has no entry in the pricing table. Never guessed —
   * an unpriced call renders as "unpriced", not as $0.00 (SPEC section 4).
   */
  costUsd: number | null;
  durationMs: number;
  /** Provider's own stop reason, kept verbatim for the run inspector. */
  stopReason: string | null;
};

export interface ModelProvider {
  id: string;
  /** Throws on transport or API failure; callers record the error on the job. */
  complete(req: ModelRequest, apiKey: string): Promise<ModelResponse>;
  /** Lists model ids the key can actually reach, for the settings screen. */
  listModels(apiKey: string): Promise<string[]>;
}
