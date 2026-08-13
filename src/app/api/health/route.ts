import { NextResponse } from "next/server";
import { runHealthChecks } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await runHealthChecks();
  return NextResponse.json(report, {
    status: report.status === "fail" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
