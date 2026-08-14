import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MODE } from "@/lib/demo";
import { getEnv } from "@/lib/env";
import { runWorker } from "@/lib/jobs/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Worker entry point. Driven by the scheduled GitHub Actions workflow in
 * .github/workflows/worker.yml, and by the "run now" button in the jobs UI.
 *
 * The schedule used to be a Vercel cron in vercel.json. Vercel's Hobby plan
 * allows only daily crons and rejects a deployment carrying anything more
 * frequent, so it moved to Actions, where a fifteen-minute schedule is free.
 * Nothing here changed with it.
 *
 * When CRON_SECRET is set, requests must present it as a bearer token; the
 * workflow sends it from a repository secret. Left unset (local development)
 * the route is open, which is fine locally and is not fine on a public
 * deployment — anything that can reach it can drain the queue.
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

  /*
   * A demo instance drains nothing.
   *
   * DEMO_MODE blocks the buttons that enqueue chargeable work, but the planner
   * is deliberately left open — it costs nothing and its output is the point of
   * step 3. It does enqueue `run_agent` jobs, and a scheduled worker would have
   * executed those on the owner's account every fifteen minutes. Gating the
   * button and leaving the schedule open would have been a gate with a hole in
   * it.
   *
   * 200 rather than 403: the caller is a cron, and a refusal is a correct
   * outcome, not a failure to alert on. The queued rows stay visible in /jobs.
   */
  if (DEMO_MODE) {
    return NextResponse.json(
      {
        refused: "DEMO_MODE is on; this instance does not run queued work.",
        recovered: 0,
        processed: [],
        hitLimit: false,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

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
