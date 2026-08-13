import { NextResponse, type NextRequest } from "next/server";
import { apiListArtifacts } from "@/lib/api";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** GET /api/v1/artifacts?status=draft|approved|published|rejected|stale */
export async function GET(req: NextRequest) {
  const ws = await getOrCreateDefaultWorkspace();
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const artifacts = await apiListArtifacts(ws.id, status);
  return NextResponse.json(
    { count: artifacts.length, artifacts },
    { headers: { "cache-control": "no-store" } },
  );
}
