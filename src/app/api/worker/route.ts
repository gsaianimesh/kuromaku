import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { runWorker } from "@/lib/jobs/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Worker entry point. Driven by the Vercel cron in vercel.json, and by the
 * "run now" button in the jobs UI.
 *
 * When CRON_SECRET is set, requests must present it. Vercel's cron sends it as
 * a bearer token automatically. Left unset (local development) the route is
 * open, which is fine because it only drains a queue that only this app fills.
 */
function authorised(req: NextRequest): boolean {
  let secret: string | undefined;
  try {
    secret = getEnv().CRON_SECRET;
  } catch {
    return false;
  }
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const url = new URL(req.url);
  const maxJobs = Number(url.searchParams.get("maxJobs") ?? 10);

  const startedAt = Date.now();
  const result = await runWorker({
    maxJobs: Number.isFinite(maxJobs) ? maxJobs : 10,
  });

  return NextResponse.json(
    { ...result, elapsedMs: Date.now() - startedAt },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = handle;
export const POST = handle;
