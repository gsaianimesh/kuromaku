import "server-only";
import { getHandler } from "./handlers";
import {
  claimNext,
  completeJob,
  failJob,
  recoverStaleJobs,
} from "./queue";

/**
 * Drains the queue. Invoked by the cron trigger and by the "run now" button
 * (SPEC section 5).
 */

export type WorkerJobResult = {
  jobId: string;
  type: string;
  outcome: "done" | "retrying" | "failed";
  durationMs: number;
  log: string[];
  error?: string;
};

export type WorkerResult = {
  recovered: number;
  processed: WorkerJobResult[];
  /** True when the loop stopped because it hit a limit, not because it drained. */
  hitLimit: boolean;
};

export type WorkerOptions = {
  /** Most jobs to process in one invocation. */
  maxJobs?: number;
  /** Wall-clock budget, so a serverless invocation returns before its timeout. */
  budgetMs?: number;
};

export async function runWorker(
  opts: WorkerOptions = {},
): Promise<WorkerResult> {
  const maxJobs = opts.maxJobs ?? 10;
  const budgetMs = opts.budgetMs ?? 25_000;
  const startedAt = Date.now();

  const recovered = await recoverStaleJobs();
  const processed: WorkerJobResult[] = [];
  let hitLimit = false;

  while (processed.length < maxJobs) {
    if (Date.now() - startedAt > budgetMs) {
      hitLimit = true;
      break;
    }

    const job = await claimNext();
    if (!job) break;

    const jobStartedAt = Date.now();
    const log: string[] = [];
    const ctx = { job, log: (m: string) => log.push(m) };

    try {
      const handler = getHandler(job.type);
      if (!handler) {
        throw new Error(
          `No handler registered for job type "${job.type}". Register one in lib/jobs/handlers.ts.`,
        );
      }

      // Validation happens inside execute, so an invalid payload fails the job
      // with a readable message rather than reaching handler code.
      await handler.execute(job.payload, ctx);
      await completeJob(job.id);
      processed.push({
        jobId: job.id,
        type: job.type,
        outcome: "done",
        durationMs: Date.now() - jobStartedAt,
        log,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await failJob(job.id, message);
      processed.push({
        jobId: job.id,
        type: job.type,
        outcome,
        durationMs: Date.now() - jobStartedAt,
        log,
        error: message,
      });
    }
  }

  if (processed.length >= maxJobs) hitLimit = true;
  return { recovered, processed, hitLimit };
}
