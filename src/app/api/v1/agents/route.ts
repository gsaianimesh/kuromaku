import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiListAgents, apiRunAgent } from "@/lib/api";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** GET /api/v1/agents — the registry, which is seeded in code. */
export async function GET() {
  return NextResponse.json({ agents: apiListAgents() });
}

const runSchema = z.object({
  agentId: z.string().min(1),
  channel: z.string().optional(),
  locale: z.string().optional(),
});

/**
 * POST /api/v1/agents — queues a run. Never publishes; the result lands in the
 * review queue like every other draft.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  try {
    const ws = await getOrCreateDefaultWorkspace();
    const result = await apiRunAgent(ws.id, parsed.data);
    return NextResponse.json(result, { status: result.created ? 202 : 200 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 400 },
    );
  }
}
