"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { enqueue } from "@/lib/jobs/queue";
import { runWorker, type WorkerResult } from "@/lib/jobs/worker";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export type EnqueueState = {
  ok: boolean;
  message: string;
  created?: boolean;
  jobId?: string;
} | null;

const enqueueSchema = z.object({
  idempotencyKey: z.string().trim().min(1, "An idempotency key is required"),
  sleepMs: z.coerce.number().int().min(0).max(10_000),
  shouldFail: z.boolean(),
});

export async function enqueueNoopAction(
  _prev: EnqueueState,
  formData: FormData,
): Promise<EnqueueState> {
  const parsed = enqueueSchema.safeParse({
    idempotencyKey: formData.get("idempotencyKey"),
    sleepMs: formData.get("sleepMs"),
    shouldFail: formData.get("shouldFail") === "on",
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  try {
    const ws = await getOrCreateDefaultWorkspace();
    const { job, created } = await enqueue({
      workspaceId: ws.id,
      type: "noop",
      idempotencyKey: parsed.data.idempotencyKey,
      payload: {
        sleepMs: parsed.data.sleepMs,
        shouldFail: parsed.data.shouldFail,
        label: "enqueued from the UI",
      },
      reason: "Manually enqueued from the jobs screen to exercise the queue.",
    });

    revalidatePath("/jobs");
    return {
      ok: true,
      created,
      jobId: job.id,
      message: created
        ? `Job created with idempotency key "${parsed.data.idempotencyKey}".`
        : `No new job. Idempotency key "${parsed.data.idempotencyKey}" already belongs to a ${job.status} job — the existing one was returned.`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Failed to enqueue",
    };
  }
}

export type RunState = { result: WorkerResult; at: string } | null;

export async function runWorkerAction(): Promise<RunState> {
  const result = await runWorker({ maxJobs: 10 });
  revalidatePath("/jobs");
  return { result, at: new Date().toISOString() };
}
