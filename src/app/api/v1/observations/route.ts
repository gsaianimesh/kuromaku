import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiRecordObservation } from "@/lib/api";
import { listObservations } from "@/lib/publish";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  const ws = await getOrCreateDefaultWorkspace();
  const rows = await listObservations(ws.id, 200);
  return NextResponse.json(
    {
      count: rows.length,
      observations: rows.map((o) => ({
        id: o.id,
        metric: o.metric,
        value: Number(o.value),
        source: o.source,
        observedAt: o.observedAt.toISOString(),
        artifactId: o.artifactId,
        channel: o.channel,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

const schema = z.object({
  artifactId: z.string().uuid(),
  metric: z.string().min(1),
  value: z.number(),
});

/** POST /api/v1/observations — the import path for measured performance. */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  try {
    const ws = await getOrCreateDefaultWorkspace();
    await apiRecordObservation(ws.id, parsed.data);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 400 },
    );
  }
}
