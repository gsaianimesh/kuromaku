import "server-only";

import { costOf } from "./pricing";
import {
  estimateTokens,
  parseResetDuration,
  recordLimits,
  waitForBudget,
} from "./ratelimit";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";

/**
 * Groq's OpenAI-compatible chat completions endpoint. Raw fetch rather than the
 * OpenAI SDK: the surface used here is one POST, and a dependency whose only job
 * is to build that body is not worth the weight.
 */

const BASE = "https://api.groq.com/openai/v1";
/**
 * Default ceiling on how long a single call may sleep on a provider rate limit.
 * Sized just over the one-minute token bucket, so ordinary pacing still happens
 * inline and nothing longer does. Callers with no queue to fall back on raise it
 * through `ModelRequest.maxWaitMs`.
 */
const DEFAULT_MAX_INLINE_WAIT_MS = 90_000;

type GroqResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
};

export const groqProvider: ModelProvider = {
  id: "groq",

  async complete(req: ModelRequest, apiKey: string): Promise<ModelResponse> {
    const startedAt = Date.now();

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    const maxTokens = req.maxTokens ?? 8000;
    const promptTokens = estimateTokens(messages.map((m) => m.content).join("\n"));

    // Wait out the token bucket rather than burning an attempt on a 429.
    await waitForBudget(req.model, promptTokens + maxTokens, (ms) =>
      req.onWait?.(`rate limit: waiting ${Math.ceil(ms / 1000)}s for ${req.model}`),
    );

    let res: Response;
    let body: GroqResponse = {};

    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
          ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });

      recordLimits(req.model, res.headers);
      body = (await res.json().catch(() => ({}))) as GroqResponse;

      if (res.status === 429 && attempt <= 4) {
        const waitMs =
          parseResetDuration(res.headers.get("retry-after")) ??
          parseResetDuration(res.headers.get("x-ratelimit-reset-tokens")) ??
          15_000;

        /*
         * A minute-scale wait is the token bucket refilling and worth sitting
         * through. Anything longer is a daily or request-count limit, and
         * sleeping on it inside the handler holds the job's lock while doing
         * nothing — which is how a drain sat for twenty-three minutes with no
         * model call in flight and no way to tell from the outside. Past the
         * cap, fail: the queue already knows how to requeue with backoff, and a
         * requeued job releases its lock and lets the rest of the queue move.
         */
        const ceiling = req.maxWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS;
        if (waitMs > ceiling) {
          throw new Error(
            `Groq rate limit needs ${Math.ceil(waitMs / 1000)}s, longer than the ${
              ceiling / 1000
            }s this caller will wait inline. Requeued rather than held.`,
          );
        }

        req.onWait?.(
          `rate limited, retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}/4)`,
        );
        await new Promise((r) => setTimeout(r, waitMs + 500));
        continue;
      }

      // Capacity and transient server errors. Groq's own guidance for a 503 on
      // a busy model is to back off exponentially rather than fail the work.
      if ([500, 502, 503, 529].includes(res.status) && attempt <= 4) {
        const waitMs = Math.min(4000 * 2 ** (attempt - 1), 60_000);
        req.onWait?.(
          `${req.model} returned ${res.status}, backing off ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}/4)`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!res.ok) {
      // The key must never reach a log line, so only the message is surfaced.
      const detail = body.error?.message ?? res.statusText;
      if (res.status === 413) {
        throw new Error(
          `Groq 413: the request exceeds this model's per-minute token limit. Reduce the prompt or use a model with a higher limit. ${detail}`,
        );
      }
      throw new Error(`Groq ${res.status}: ${detail}`);
    }

    const text = body.choices?.[0]?.message?.content ?? "";
    const inputTokens = body.usage?.prompt_tokens ?? null;
    const outputTokens = body.usage?.completion_tokens ?? null;

    return {
      text,
      model: req.model,
      inputTokens,
      outputTokens,
      costUsd: costOf(req.model, inputTokens, outputTokens),
      durationMs: Date.now() - startedAt,
      stopReason: body.choices?.[0]?.finish_reason ?? null,
    };
  },

  async listModels(apiKey: string): Promise<string[]> {
    const res = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: could not list models`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).sort();
  },
};
