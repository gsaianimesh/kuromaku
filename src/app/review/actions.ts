"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reviewArtifact } from "@/lib/review";
import { enqueue } from "@/lib/jobs/queue";
import { runWorker } from "@/lib/jobs/worker";
import { getArtifact } from "@/lib/review";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export type ReviewState = {
  ok: boolean;
  message: string;
  editDistance?: number | null;
} | null;

const schema = z.object({
  artifactId: z.string().uuid(),
  decision: z.enum(["approve", "edit", "reject"]),
  editedContent: z.string().optional(),
  reason: z.string().optional(),
});

export async function reviewAction(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const parsed = schema.safeParse({
    artifactId: formData.get("artifactId"),
    decision: formData.get("decision"),
    editedContent: formData.get("editedContent") ?? undefined,
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  try {
    const { editDistance } = await reviewArtifact(parsed.data);
    revalidatePath("/review");
    revalidatePath("/metrics");
    return {
      ok: true,
      editDistance,
      message:
        parsed.data.decision === "edit"
          ? `Approved with edits. Normalised edit distance ${editDistance?.toFixed(3)} recorded against this agent.`
          : parsed.data.decision === "approve"
            ? "Approved unchanged. No edit distance recorded, because nothing was edited."
            : "Rejected. The reason is stored on the review.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Review failed" };
  }
}

/** Re-runs the agent that produced a stale artifact (SPEC 7.3). */
export async function regenerateAction(artifactId: string): Promise<ReviewState> {
  const artifact = await getArtifact(artifactId);
  if (!artifact) return { ok: false, message: "Artifact not found" };

  const ws = await getOrCreateDefaultWorkspace();
  const { job, created } = await enqueue({
    workspaceId: ws.id,
    type: "run_agent",
    idempotencyKey: `regen:${artifactId}`,
    payload: {
      agentId: artifact.agentId,
      channel: artifact.channel,
      locale: artifact.locale,
    },
    reason: `Regenerating a stale draft: the memory it was derived from has been superseded.`,
  });

  revalidatePath("/review");
  revalidatePath("/jobs");
  return {
    ok: true,
    message: created
      ? "Regeneration queued. Run the worker to produce a fresh draft from current memory."
      : `A regeneration is already ${job.status}.`,
  };
}

export async function runQueuedWorkAction(): Promise<{
  log: string[];
  outcomes: string[];
}> {
  const result = await runWorker({ maxJobs: 3, budgetMs: 280_000 });
  revalidatePath("/review");
  revalidatePath("/jobs");
  revalidatePath("/metrics");
  return {
    log: result.processed.flatMap((p) => p.log),
    outcomes: result.processed.map(
      (p) => `${p.type}: ${p.outcome}${p.error ? ` — ${p.error}` : ""}`,
    ),
  };
}
