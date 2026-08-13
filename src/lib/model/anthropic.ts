import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { costOf } from "./pricing";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";

/**
 * Anthropic via the official SDK, per SPEC section 5. Kept behind the same
 * ModelProvider seam as Groq so the compiler and agents never branch on
 * provider.
 */
export const anthropicProvider: ModelProvider = {
  id: "anthropic",

  async complete(req: ModelRequest, apiKey: string): Promise<ModelResponse> {
    const startedAt = Date.now();
    const client = new Anthropic({ apiKey });

    // JSON mode has no direct analogue here; the system prompt carries the
    // instruction and Zod validates the result (SPEC 7.2), which is the same
    // path Groq takes, so behaviour stays identical across providers.
    const system = req.jsonMode
      ? `${req.system ?? ""}\n\nRespond with a single valid JSON object and nothing else. No prose, no markdown fences.`.trim()
      : req.system;

    const response = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 8000,
      ...(system ? { system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const inputTokens = response.usage.input_tokens ?? null;
    const outputTokens = response.usage.output_tokens ?? null;

    return {
      text,
      model: response.model,
      inputTokens,
      outputTokens,
      costUsd: costOf(response.model, inputTokens, outputTokens),
      durationMs: Date.now() - startedAt,
      stopReason: response.stop_reason ?? null,
    };
  },

  async listModels(apiKey: string): Promise<string[]> {
    const client = new Anthropic({ apiKey });
    const out: string[] = [];
    for await (const m of client.models.list()) out.push(m.id);
    return out.sort();
  },
};
