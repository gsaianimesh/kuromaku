"use server";

import { revalidatePath } from "next/cache";
import { acknowledgeGap } from "@/lib/planner";
import { enqueue } from "@/lib/jobs/queue";
import { runWorker } from "@/lib/jobs/worker";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export async function runPlannerAction(): Promise<{
  log: string[];
  outcome: string | null;
}> {
  const ws = await getOrCreateDefaultWorkspace();
  // Time-bucketed so repeated clicks in one minute do not stack planner runs,
  // while a deliberate re-plan a minute later still works.
  const bucket = new Date().toISOString().slice(0, 16);
  await enqueue({
    workspaceId: ws.id,
    type: "run_planner",
    idempotencyKey: `plan:${ws.id}:${bucket}`,
    payload: {},
    reason: "Manual planner run.",
  });

  const result = await runWorker({ maxJobs: 1, budgetMs: 120_000 });
  revalidatePath("/planner");
  revalidatePath("/jobs");
  revalidatePath("/review");

  const plan = result.processed.find((p) => p.type === "run_planner");
  return {
    log: plan?.log ?? [],
    outcome: plan ? (plan.error ? `${plan.outcome}: ${plan.error}` : plan.outcome) : null,
  };
}

export async function acknowledgeGapAction(id: string): Promise<void> {
  await acknowledgeGap(id);
  revalidatePath("/planner");
}
