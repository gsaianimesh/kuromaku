"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { markAsPosted, recordObservation } from "@/lib/publish";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export type PublishState = { ok: boolean; message: string } | null;

const postedSchema = z.object({
  artifactId: z.string().uuid(),
  externalUrl: z.string().min(4),
});

export async function markPostedAction(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const parsed = postedSchema.safeParse({
    artifactId: formData.get("artifactId"),
    externalUrl: formData.get("externalUrl"),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }
  try {
    await markAsPosted(parsed.data.artifactId, parsed.data.externalUrl);
    revalidatePath("/publish");
    revalidatePath("/review");
    return {
      ok: true,
      message: "Marked as posted. Performance can now be recorded against it.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed" };
  }
}

const observationSchema = z.object({
  artifactId: z.string().uuid(),
  metric: z.string().trim().min(1),
  value: z.coerce.number(),
  observedAt: z.string().optional(),
});

export async function recordObservationAction(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const parsed = observationSchema.safeParse({
    artifactId: formData.get("artifactId"),
    metric: formData.get("metric"),
    value: formData.get("value"),
    observedAt: formData.get("observedAt") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  try {
    const ws = await getOrCreateDefaultWorkspace();
    await recordObservation({
      workspaceId: ws.id,
      artifactId: parsed.data.artifactId,
      metric: parsed.data.metric,
      value: parsed.data.value,
      source: "manual",
      observedAt: parsed.data.observedAt
        ? new Date(parsed.data.observedAt)
        : undefined,
    });
    revalidatePath("/publish");
    revalidatePath("/metrics");
    revalidatePath("/review");
    return {
      ok: true,
      message: `Recorded ${parsed.data.metric} = ${parsed.data.value}. The planner reads observations on its next run.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed" };
  }
}
