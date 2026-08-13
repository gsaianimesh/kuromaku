import "server-only";
import { z } from "zod";
import { getDb } from "../db";
import { agentRuns } from "../db/schema";
import { resolveModelKey, type ModelProviderId } from "../settings";
import { anthropicProvider } from "./anthropic";
import { groqProvider } from "./groq";
import { isPriced } from "./pricing";
import type { ChatMessage, ModelProvider, ModelResponse } from "./types";

export type { ChatMessage, ModelResponse } from "./types";
export { PRICING, isPriced } from "./pricing";

/**
 * Task routing (SPEC section 5): "a strong model for compilation and critique,
 * a cheap fast model for routine drafting and classification. Make the mapping
 * a single config object."
 *
 * This is that object. Changing which model does what is an edit here and
 * nowhere else.
 */
export type ModelTask = "compile" | "critique" | "draft" | "classify";

export const MODEL_CONFIG: Record<ModelProviderId, Record<ModelTask, string>> = {
  groq: {
    compile: "openai/gpt-oss-120b",
    critique: "openai/gpt-oss-120b",
    draft: "llama-3.3-70b-versatile",
    classify: "llama-3.1-8b-instant",
  },
  anthropic: {
    compile: "claude-opus-5",
    critique: "claude-opus-5",
    draft: "claude-sonnet-5",
    classify: "claude-haiku-4-5",
  },
};

const PROVIDERS: Record<ModelProviderId, ModelProvider> = {
  groq: groqProvider,
  anthropic: anthropicProvider,
};

export function getProvider(id: ModelProviderId): ModelProvider {
  return PROVIDERS[id];
}

export type RunModelInput = {
  workspaceId: string;
  /** Every model call belongs to a job, so the run inspector can find it. */
  jobId: string;
  /** Which agent or compiler stage made the call. */
  agentId: string;
  task: ModelTask;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  /** Surfaces provider rate-limit waits into the job log. */
  onWait?: (message: string) => void;
};

export class NoModelKeyError extends Error {
  constructor() {
    super(
      "No model key available. Add one at /settings, or set GROQ_API_KEY for local development.",
    );
    this.name = "NoModelKeyError";
  }
}

/**
 * The only way to call a model. Logs prompt, model, token counts, cost and
 * duration to `agent_runs` whether the call succeeds or fails — SPEC section 4
 * requires every call to be inspectable, and a failed call is the one you most
 * want to see.
 */
export async function runModel(input: RunModelInput): Promise<ModelResponse> {
  const resolved = await resolveModelKey(input.workspaceId);
  if (!resolved) throw new NoModelKeyError();

  const provider = getProvider(resolved.provider);
  const model = MODEL_CONFIG[resolved.provider][input.task];
  const db = getDb();

  const promptForLog = [
    input.system ? `[system]\n${input.system}` : null,
    ...input.messages.map((m) => `[${m.role}]\n${m.content}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  const startedAt = Date.now();
  try {
    const response = await provider.complete(
      {
        model,
        system: input.system,
        messages: input.messages,
        maxTokens: input.maxTokens,
        jsonMode: input.jsonMode,
        onWait: input.onWait,
      },
      resolved.key,
    );

    await db.insert(agentRuns).values({
      jobId: input.jobId,
      agentId: input.agentId,
      model: response.model,
      prompt: promptForLog,
      rawOutput: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd === null ? null : response.costUsd.toFixed(6),
      durationMs: response.durationMs,
      toolCalls: { task: input.task, stopReason: response.stopReason },
    });

    return response;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.insert(agentRuns).values({
      jobId: input.jobId,
      agentId: input.agentId,
      model,
      prompt: promptForLog,
      rawOutput: `ERROR: ${message}`,
      durationMs: Date.now() - startedAt,
      toolCalls: { task: input.task, failed: true },
    });
    throw e;
  }
}

/** Strips markdown fences and leading prose some models add despite instructions. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return candidate;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  return end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
}

export class ModelJsonError extends Error {
  constructor(
    message: string,
    /** Kept so the job can store what the model actually said (SPEC 7.2). */
    public readonly rawOutput: string,
  ) {
    super(message);
    this.name = "ModelJsonError";
  }
}

/**
 * Structured output the way SPEC 7.2 specifies: ask for strict JSON, validate
 * with Zod, retry once on a parse failure, then fail with the raw output kept.
 */
export async function runModelJson<T>(
  input: Omit<RunModelInput, "jsonMode">,
  schema: z.ZodType<T>,
): Promise<{ value: T; response: ModelResponse; attempts: number }> {
  let lastRaw = "";
  let lastProblem = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages =
      attempt === 1
        ? input.messages
        : [
            ...input.messages,
            {
              role: "assistant" as const,
              content: lastRaw.slice(0, 2000),
            },
            {
              role: "user" as const,
              content: `That response could not be used: ${lastProblem}\n\nReturn only a single valid JSON value matching the requested shape. No prose, no markdown fences.`,
            },
          ];

    const response = await runModel({ ...input, messages, jsonMode: true });
    lastRaw = response.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(response.text));
    } catch (e) {
      lastProblem = `not valid JSON (${e instanceof Error ? e.message : "parse error"})`;
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { value: result.data, response, attempts: attempt };
    }
    lastProblem = result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  throw new ModelJsonError(
    `Model did not return usable JSON after 2 attempts. Last problem: ${lastProblem}`,
    lastRaw,
  );
}

/** For the settings screen: does this workspace have a working key? */
export async function checkModelAccess(workspaceId: string): Promise<
  | { ok: true; provider: string; source: "byok" | "env"; models: string[] }
  | { ok: false; error: string }
> {
  const resolved = await resolveModelKey(workspaceId);
  if (!resolved) return { ok: false, error: "No key stored and no env fallback set." };
  try {
    const models = await getProvider(resolved.provider).listModels(resolved.key);
    return {
      ok: true,
      provider: resolved.provider,
      source: resolved.source,
      models,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Which configured models lack a price entry, so the UI can say so. */
export function unpricedTasks(provider: ModelProviderId): ModelTask[] {
  return (Object.keys(MODEL_CONFIG[provider]) as ModelTask[]).filter(
    (t) => !isPriced(MODEL_CONFIG[provider][t]),
  );
}
