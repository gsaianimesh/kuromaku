/**
 * Runs the whole pipeline once against the real database and real model calls:
 * crawl, compile, plan, draft.
 *
 *   npm run refresh
 *
 * This is the script that produced the state every screenshot in
 * submission/ was captured from. It is destructive in the ordinary way a
 * re-run is: records are superseded, not deleted, and prior drafts are left
 * alone unless --fresh-drafts is passed.
 *
 * Expect it to take a while. On a rate-limited tier the compiler waits out the
 * provider's token budget between stages, and that wait is the point — the
 * alternative was a weaker model that compiled an audience the site never
 * mentions.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { and, eq, inArray, sql } from "drizzle-orm";

const FRESH_DRAFTS = process.argv.includes("--fresh-drafts");
const SKIP_CRAWL = process.argv.includes("--skip-crawl");

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string) {
  console.log(`[${stamp()}] ${msg}`);
}
function section(n: string) {
  console.log(`\n── ${n} ${"─".repeat(Math.max(0, 56 - n.length))}\n`);
}

/**
 * Runs the worker until the named job type reaches a terminal state.
 *
 * `runWorker({ maxJobs: 1 })` claims the *oldest* queued row, which is not
 * necessarily the one just enqueued. A single stuck job — in this case a
 * malformed crawl left queued by an earlier run — sat at the head of the queue
 * and every phase here claimed something else instead, so the planner ran
 * against the memory the compile was about to replace and the drafts were
 * written from records that no longer existed by the time they were read.
 */
async function drainUntilDone(
  runWorker: (o: { maxJobs: number; budgetMs: number }) => Promise<{
    processed: Array<{ type: string; outcome: string; error?: string; log: string[] }>;
  }>,
  type: string,
  budgetMs: number,
): Promise<{ outcome: string; log: string[] } | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const res = await runWorker({ maxJobs: 4, budgetMs: deadline - Date.now() });
    if (res.processed.length === 0) return null;
    for (const p of res.processed) {
      log(`  ran ${p.type} → ${p.outcome}${p.error ? ` — ${p.error.slice(0, 120)}` : ""}`);
    }
    const mine = res.processed.find((p) => p.type === type);
    if (mine && mine.outcome !== "retrying") return mine;
  }
  return null;
}

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { artifacts, jobs, memoryRecords } = await import("../src/lib/db/schema");
  const { enqueue } = await import("../src/lib/jobs/queue");
  const { runWorker } = await import("../src/lib/jobs/worker");
  const { runPlanner } = await import("../src/lib/planner");
  const { getOrCreateDefaultWorkspace } = await import("../src/lib/workspace");
  const { memoryStats } = await import("../src/lib/memory");

  const db = getDb();
  const ws = await getOrCreateDefaultWorkspace();
  log(`workspace ${ws.name} (${ws.domain})`);

  // A queued row that can never succeed blocks every phase behind it, because
  // the worker always claims the oldest first. Clear the queue this run owns.
  const cleared = await db
    .delete(jobs)
    .where(inArray(jobs.type, ["crawl_site", "compile_strategy", "run_agent", "run_planner"]))
    .returning({ id: jobs.id });
  log(`cleared ${cleared.length} queued or finished job row(s) from previous runs`);

  // ------------------------------------------------------------------ crawl
  if (!SKIP_CRAWL) {
    section("Crawl");
    await enqueue({
      workspaceId: ws.id,
      type: "crawl_site",
      idempotencyKey: `crawl:${ws.id}`,
      payload: { domain: ws.domain },
    });
    const crawled = await drainUntilDone(runWorker, "crawl_site", 600_000);
    log(`crawl: ${crawled?.outcome ?? "did not finish"}`);
  }

  // ---------------------------------------------------------------- compile
  section("Compile");
  await enqueue({
    workspaceId: ws.id,
    type: "compile_strategy",
    idempotencyKey: `compile:${ws.id}`,
    payload: {},
  });
  const compiled = await drainUntilDone(runWorker, "compile_strategy", 1_800_000);
  log(`compile: ${compiled?.outcome ?? "did not finish"}`);
  for (const line of compiled?.log.slice(-40) ?? []) console.log(`      ${line}`);
  if (compiled?.outcome !== "done") {
    console.error(
      "\nCompile did not finish. Nothing downstream would be built from current memory.",
    );
    process.exit(1);
  }

  const stats = await memoryStats(ws.id);
  log(
    `memory: ${stats.total} active — ${stats.sourced} sourced, ${stats.derived} derived, ` +
      `${stats.unsourced} ungrounded, avg confidence ${stats.averageConfidence?.toFixed(3) ?? "—"}`,
  );

  // The compiled ICP is the thing most worth eyeballing before anything is
  // drafted from it: every draft inherits whoever it says the audience is.
  const icp = await db
    .select({ key: memoryRecords.key, confidence: memoryRecords.confidence, value: memoryRecords.value })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, ws.id),
        eq(memoryRecords.status, "active"),
        eq(memoryRecords.type, "icp_segment"),
      ),
    );
  console.log("\n  compiled ICP segments:");
  for (const r of icp) {
    const v = r.value as { segment?: string };
    console.log(`    ${r.key.padEnd(28)} ${r.confidence.toFixed(2)}  ${v.segment ?? ""}`);
  }

  // ---------------------------------------------------------------- planner
  section("Plan");
  if (FRESH_DRAFTS) {
    const gone = await db
      .delete(artifacts)
      .where(and(eq(artifacts.workspaceId, ws.id), eq(artifacts.status, "draft")))
      .returning({ id: artifacts.id });
    log(`cleared ${gone.length} existing draft(s)`);
  }

  const plan = await runPlanner(ws.id, (m) => log(`  ${m}`));
  log(`scheduled ${plan.scheduled.length}, skipped ${plan.skipped.length}, gaps ${plan.gaps.length}`);
  for (const s of plan.scheduled) log(`  + ${s.channel}: ${s.reason.slice(0, 96)}`);
  for (const s of plan.skipped) log(`  - ${s.channel}: ${s.why.slice(0, 96)}`);

  // ----------------------------------------------------------------- drafts
  section("Draft");
  const drafted = await runWorker({ maxJobs: 12, budgetMs: 1_800_000 });
  for (const p of drafted.processed) {
    log(`draft: ${p.type} → ${p.outcome}${p.error ? ` — ${p.error.slice(0, 140)}` : ""}`);
  }

  const [final] = await db
    .select({
      drafts: sql<number>`count(*) filter (where status = 'draft')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(artifacts)
    .where(eq(artifacts.workspaceId, ws.id));
  log(`artifacts: ${final.total} total, ${final.drafts} draft`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
