import { NextResponse, type NextRequest } from "next/server";
import { apiGetMemory, apiSearchMemory } from "@/lib/api";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/memory?type=&locale=&q=
 *
 * Every record carries its sources and an `unsourced` flag. Okara is closed
 * with no API; being open is the point (SPEC 7.11).
 */
export async function GET(req: NextRequest) {
  const ws = await getOrCreateDefaultWorkspace();
  const url = new URL(req.url);
  const q = url.searchParams.get("q");

  const records = q
    ? await apiSearchMemory(ws.id, q, Number(url.searchParams.get("limit") ?? 20))
    : await apiGetMemory(ws.id, {
        type: url.searchParams.get("type") ?? undefined,
        locale: url.searchParams.get("locale") ?? undefined,
      });

  return NextResponse.json(
    {
      workspace: { id: ws.id, name: ws.name, domain: ws.domain },
      count: records.length,
      unsourced: records.filter((r) => r.unsourced).length,
      records,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
