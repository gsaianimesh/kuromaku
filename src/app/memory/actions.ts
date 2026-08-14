"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { demoRefusal } from "@/lib/demo";
import { editRecord } from "@/lib/memory";
import { enqueue } from "@/lib/jobs/queue";
import { runWorker } from "@/lib/jobs/worker";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export type CompileState = {
  ok: boolean;
  message: string;
} | null;

export async function startCompileAction(): Promise<CompileState> {
  const refused = demoRefusal("Queueing a compile");
  if (refused) return refused;

  const ws = await getOrCreateDefaultWorkspace();
  const { job, created } = await enqueue({
    workspaceId: ws.id,
    type: "compile_strategy",
    // One key for the whole compile (SPEC 7.2). A completed compile releases it,
    // so re-compiling is possible and supersedes rather than duplicating.
    idempotencyKey: `compile:${ws.id}`,
    payload: {},
    reason: "Manual strategy compile from the memory screen.",
  });
  revalidatePath("/memory");
  revalidatePath("/jobs");
  return {
    ok: true,
    message: created
      ? "Compile queued. Run it below."
      : `A compile is already ${job.status}. Returned the existing job.`,
  };
}

export async function runCompileNowAction(): Promise<{
  log: string[];
  outcome: string | null;
}> {
  const refused = demoRefusal("Running a compile");
  if (refused) return { log: [refused.message], outcome: "refused" };

  const result = await runWorker({ maxJobs: 2, budgetMs: 280_000 });
  revalidatePath("/memory");
  revalidatePath("/jobs");
  const compile = result.processed.find((p) => p.type === "compile_strategy");
  return {
    log: compile?.log ?? [],
    outcome: compile
      ? compile.error
        ? `${compile.outcome}: ${compile.error}`
        : compile.outcome
      : null,
  };
}

const editSchema = z.object({
  recordId: z.string().uuid(),
  value: z.string().min(2),
  confidence: z.coerce.number().min(0).max(1),
});

export type EditState = {
  ok: boolean;
  message: string;
  staleCount?: number;
} | null;

export async function editRecordAction(
  _prev: EditState,
  formData: FormData,
): Promise<EditState> {
  const parsed = editSchema.safeParse({
    recordId: formData.get("recordId"),
    value: formData.get("value"),
    confidence: formData.get("confidence"),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  let value: Record<string, unknown>;
  try {
    const raw = JSON.parse(parsed.data.value);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, message: "The value must be a JSON object." };
    }
    value = raw as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      message: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
    };
  }

  try {
    const { staleArtifactIds } = await editRecord(
      parsed.data.recordId,
      value,
      parsed.data.confidence,
    );
    revalidatePath("/memory");
    revalidatePath("/review");
    return {
      ok: true,
      staleCount: staleArtifactIds.length,
      message:
        staleArtifactIds.length === 0
          ? "Saved as a new version. The previous version is kept in history. No artifacts derived from this record yet."
          : `Saved as a new version. ${staleArtifactIds.length} artifact(s) derived from the previous version are now marked stale.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Edit failed" };
  }
}
