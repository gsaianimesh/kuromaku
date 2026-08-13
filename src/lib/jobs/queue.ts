import "server-only";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { agentRuns, jobs, type Job } from "../db/schema";

/**
 * Postgres-backed queue (SPEC section 5). No third-party queue service.
 *
 * Claiming is a single atomic statement rather than a transaction, because the
 * Neon HTTP driver runs every statement in its own implicit transaction — a
 * bare `SELECT … FOR UPDATE SKIP LOCKED` would release its lock before the
 * follow-up UPDATE ran, and two workers could claim the same row. Wrapping the
 * select inside the UPDATE keeps the lock and the write in one statement.
 */

/** A job stuck in `running` longer than this is assumed to have died mid-flight. */
export const STALE_LOCK_MS = 5 * 60 * 1000;

/** Retry backoff: 15s, 60s, 240s… capped. */
function backoffMs(attempts: number): number {
  return Math.min(15_000 * 4 ** (attempts - 1), 15 * 60_000);
}

export type EnqueueInput = {
  workspaceId: string;
  type: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  /** Plain-language why-this-was-scheduled. The planner always sets it. */
  reason?: string;
  runAfter?: Date;
  maxAttempts?: number;
};

export type EnqueueResult = {
  job: Job;
  /** False when an existing job with this idempotency key was returned instead. */
  created: boolean;
};

/**
 * Idempotent (SPEC section 4). A second call while the first job is still
 * queued or running returns that job rather than creating a duplicate.
 *
 * Terminal jobs (done, failed) release their key — see the index comment in
 * schema.ts. Callers that must not repeat completed work should check history
 * first; the planner does exactly that.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const db = getDb();

  const [inserted] = await db
    .insert(jobs)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      reason: input.reason,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { job: inserted, created: true };

  const [existing] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.idempotencyKey, input.idempotencyKey),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);

  return { job: existing, created: false };
}

/**
 * Claim the next runnable job. Returns null when the queue is empty.
 * Safe to call concurrently: SKIP LOCKED means competing workers take
 * different rows rather than blocking on each other.
 */
export async function claimNext(): Promise<Job | null> {
  const db = getDb();
  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      lockedAt: new Date(),
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(
      sql`${jobs.id} = (
        select id from ${jobs}
        where status = 'queued' and run_after <= now()
        order by run_after asc, created_at asc
        for update skip locked
        limit 1
      )`,
    )
    .returning();

  return claimed ?? null;
}

export async function completeJob(id: string): Promise<void> {
  const db = getDb();
  await db
    .update(jobs)
    .set({
      status: "done",
      completedAt: new Date(),
      lockedAt: null,
      error: null,
    })
    .where(eq(jobs.id, id));
}

/**
 * Requeue with backoff while attempts remain, otherwise mark failed.
 * Returns what it decided so the caller can log it.
 */
export async function failJob(
  id: string,
  error: string,
): Promise<"retrying" | "failed"> {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return "failed";

  const willRetry = job.attempts < job.maxAttempts;
  // Store the tail: a stack trace can be enormous and the head is rarely the
  // useful part when a driver wraps the cause.
  const message = error.slice(0, 4000);

  if (willRetry) {
    await db
      .update(jobs)
      .set({
        status: "queued",
        lockedAt: null,
        error: message,
        runAfter: new Date(Date.now() + backoffMs(job.attempts)),
      })
      .where(eq(jobs.id, id));
    return "retrying";
  }

  await db
    .update(jobs)
    .set({
      status: "failed",
      lockedAt: null,
      error: message,
      completedAt: new Date(),
    })
    .where(eq(jobs.id, id));
  return "failed";
}

/**
 * Recover jobs whose worker died while holding them. Without this a crashed
 * run leaves a row in `running` forever and the work silently never happens.
 */
export async function recoverStaleJobs(
  staleMs: number = STALE_LOCK_MS,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleMs);

  const stale = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "running"),
        or(isNull(jobs.lockedAt), lt(jobs.lockedAt, cutoff)),
      ),
    );

  for (const job of stale) {
    await failJob(
      job.id,
      `Worker did not report back within ${Math.round(staleMs / 1000)}s — lock expired and the job was recovered.`,
    );
  }
  return stale.length;
}

// ---------------------------------------------------------------------------
// Read helpers for the UI
// ---------------------------------------------------------------------------

export async function listJobs(workspaceId: string, limit = 50): Promise<Job[]> {
  const db = getDb();
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.workspaceId, workspaceId))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

export async function getJob(id: string): Promise<Job | null> {
  const db = getDb();
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export async function countByStatus(
  workspaceId: string,
): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.workspaceId, workspaceId))
    .groupBy(jobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * Model calls made by a job (SPEC section 4: every call is logged and viewable).
 * Ordered oldest first so the inspector reads as the sequence the job ran.
 */
export async function runsForJob(jobId: string) {
  const db = getDb();
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.jobId, jobId))
    .orderBy(agentRuns.createdAt);
}
