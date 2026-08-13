import "server-only";
import { z } from "zod";
import type { Job } from "../db/schema";

/**
 * Job type registry. Handlers are looked up by `job.type`; an unregistered type
 * fails the job with a clear message rather than silently succeeding, which is
 * the failure mode that lets work disappear.
 *
 * Phase 1 registers only `noop`. Crawl, compile, agent-run and plan land in
 * their own phases.
 */

export type JobContext = {
  job: Job;
  /** Appended to the run log and shown in the job inspector. */
  log: (message: string) => void;
};

export type JobHandler<TPayload> = {
  type: string;
  description: string;
  payloadSchema: z.ZodType<TPayload>;
  run: (payload: TPayload, ctx: JobContext) => Promise<void>;
};

/**
 * A handler with its payload type erased. Validation is folded into `execute`
 * so the registry can hold handlers of differing payload types in one map
 * without an unsound cast at the lookup site.
 */
export type RegisteredHandler = {
  type: string;
  description: string;
  execute: (payload: unknown, ctx: JobContext) => Promise<void>;
};

function register<T>(h: JobHandler<T>): [string, RegisteredHandler] {
  return [
    h.type,
    {
      type: h.type,
      description: h.description,
      execute: async (payload, ctx) => {
        const parsed = h.payloadSchema.safeParse(payload);
        if (!parsed.success) {
          throw new Error(
            `Payload does not match the schema for "${h.type}": ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
              .join("; ")}`,
          );
        }
        await h.run(parsed.data, ctx);
      },
    },
  ];
}

const noopPayload = z.object({
  /** Simulated work duration, so a claim is observable in the UI. */
  sleepMs: z.number().int().min(0).max(10_000).default(250),
  /** Forces a throw, to exercise retry and backoff. */
  shouldFail: z.boolean().default(false),
  label: z.string().optional(),
});

const noopHandler: JobHandler<z.infer<typeof noopPayload>> = {
  type: "noop",
  description:
    "Does nothing, slowly. Exists to prove the queue claims, runs, retries and completes.",
  payloadSchema: noopPayload,
  async run(payload, ctx) {
    ctx.log(`noop starting${payload.label ? ` (${payload.label})` : ""}`);
    if (payload.sleepMs > 0) {
      await new Promise((r) => setTimeout(r, payload.sleepMs));
    }
    if (payload.shouldFail) {
      throw new Error("shouldFail was set on the payload — failing deliberately");
    }
    ctx.log(`noop finished after ${payload.sleepMs}ms`);
  },
};

const HANDLERS = new Map<string, RegisteredHandler>([register(noopHandler)]);

export function getHandler(type: string): RegisteredHandler | undefined {
  return HANDLERS.get(type);
}

export function listHandlers(): Array<{ type: string; description: string }> {
  return [...HANDLERS.values()].map((h) => ({
    type: h.type,
    description: h.description,
  }));
}
