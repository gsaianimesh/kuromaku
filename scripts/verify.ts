/**
 * Acceptance checks for every phase built so far, run against the real
 * database.
 *
 *   npm run verify
 *
 * Non-destructive: any pre-existing BYOK key is restored, and every job this
 * script creates is deleted before it exits.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { jobs, settings, sources } from "../src/lib/db/schema";
import { crawlSite } from "../src/lib/ingest/crawl";
import { hashQuery, normaliseQuery } from "../src/lib/search";
import { runHealthChecks } from "../src/lib/health";
import { getKeyStatus, saveModelKey } from "../src/lib/settings";
import { getOrCreateDefaultWorkspace } from "../src/lib/workspace";
import { claimNext, enqueue, recoverStaleJobs } from "../src/lib/jobs/queue";
import { runWorker } from "../src/lib/jobs/worker";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
}

function section(name: string) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}\n`);
}

/** Keys created by this script, so cleanup can be exact. */
const PREFIX = `verify-${Date.now()}-`;

async function main() {
  const ws = await getOrCreateDefaultWorkspace();
  const db = getDb();

  // ---------------------------------------------------------------- Phase 0
  section("Phase 0 — scaffold, BYOK, health");

  const health = await runHealthChecks();
  for (const c of health.checks) {
    check(c.label, c.status === "pass", c.detail);
  }
  check(
    "Workspace bootstrap",
    Boolean(ws?.id),
    `${ws.name} (${ws.domain}) — ${ws.id}`,
  );

  const before = (
    await db
      .select({ k: settings.encryptedModelKey, p: settings.modelProvider })
      .from(settings)
      .where(eq(settings.workspaceId, ws.id))
  )[0];

  try {
    const probe = `gsk_verify_${Math.random().toString(36).slice(2, 10)}abcd`;
    await saveModelKey(ws.id, probe, "groq");

    const stored = (
      await db
        .select({ k: settings.encryptedModelKey })
        .from(settings)
        .where(eq(settings.workspaceId, ws.id))
    )[0];

    check(
      "Key is ciphertext at rest",
      Boolean(stored?.k) && !stored!.k!.includes(probe),
      `column holds a ${stored?.k?.length ?? 0}-char envelope, not the plaintext`,
    );

    const status = await getKeyStatus(ws.id);
    check(
      "Key round trip (encrypt → Postgres → decrypt)",
      status.state === "stored" && status.masked.endsWith(probe.slice(-4)),
      status.state === "stored"
        ? `read back and decrypted; tail matches (${status.masked})`
        : `unexpected state: ${status.state}`,
    );
  } finally {
    await db
      .update(settings)
      .set({
        encryptedModelKey: before?.k ?? null,
        modelProvider: before?.p ?? "groq",
      })
      .where(eq(settings.workspaceId, ws.id));
  }

  // ---------------------------------------------------------------- Phase 1
  section("Phase 1 — schema and jobs");

  const EXPECTED = [
    "workspaces",
    "settings",
    "sources",
    "memory_records",
    "record_sources",
    "research_cache",
    "jobs",
    "agent_runs",
    "artifacts",
    "artifact_evidence",
    "reviews",
    "observations",
    "coverage_gaps",
  ];
  const present = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables where table_schema = 'public'
  `);
  const names = new Set(present.rows.map((r) => r.table_name));
  const missingTables = EXPECTED.filter((t) => !names.has(t));
  check(
    "All SPEC section 6 tables exist",
    missingTables.length === 0,
    missingTables.length === 0
      ? `${EXPECTED.length}/${EXPECTED.length} present (agents is a code registry by design, not a table)`
      : `missing: ${missingTables.join(", ")}`,
  );

  // Idempotency
  const dupKey = `${PREFIX}dup`;
  const first = await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: dupKey,
    payload: { sleepMs: 0 },
    reason: "verify: idempotency",
  });
  const second = await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: dupKey,
    payload: { sleepMs: 0 },
    reason: "verify: idempotency",
  });
  const dupRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, dupKey));
  check(
    "Same idempotency key twice creates one job",
    first.created && !second.created && dupRows[0].n === 1,
    `first created=${first.created}, second created=${second.created}, rows in table=${dupRows[0].n}, same id=${first.job.id === second.job.id}`,
  );

  // Concurrent claim — the SKIP LOCKED guarantee
  await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: `${PREFIX}race-a`,
    payload: { sleepMs: 0 },
  });
  await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: `${PREFIX}race-b`,
    payload: { sleepMs: 0 },
  });
  const [c1, c2] = await Promise.all([claimNext(), claimNext()]);
  check(
    "Concurrent claims take different rows (FOR UPDATE SKIP LOCKED)",
    Boolean(c1 && c2) && c1!.id !== c2!.id,
    c1 && c2
      ? `claimed ${c1.id.slice(0, 8)} and ${c2.id.slice(0, 8)} — distinct`
      : `expected two claims, got ${[c1, c2].filter(Boolean).length}`,
  );
  check(
    "Claiming sets running and increments attempts",
    c1?.status === "running" && c1?.attempts === 1 && c1?.lockedAt !== null,
    `status=${c1?.status} attempts=${c1?.attempts} lockedAt=${c1?.lockedAt !== null}`,
  );

  // Release the two raced jobs so the drain below is deterministic.
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, attempts: 0 })
    .where(inArray(jobs.id, [c1!.id, c2!.id]));

  // Full lifecycle: claim → run → complete
  const drain = await runWorker({ maxJobs: 20 });
  const doneRow = await db
    .select()
    .from(jobs)
    .where(eq(jobs.idempotencyKey, dupKey))
    .limit(1);
  check(
    "Worker claims, runs and completes",
    doneRow[0]?.status === "done" && doneRow[0]?.completedAt !== null,
    `processed ${drain.processed.length} job(s); the tracked job is ${doneRow[0]?.status} with completedAt=${doneRow[0]?.completedAt !== null}`,
  );

  // Retry with backoff
  const failKey = `${PREFIX}fail`;
  await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: failKey,
    payload: { sleepMs: 0, shouldFail: true },
    maxAttempts: 2,
  });
  const firstPass = await runWorker({ maxJobs: 5 });
  const afterOne = (
    await db.select().from(jobs).where(eq(jobs.idempotencyKey, failKey))
  )[0];
  check(
    "A throwing job requeues with backoff rather than dying",
    afterOne.status === "queued" &&
      afterOne.attempts === 1 &&
      afterOne.runAfter.getTime() > Date.now(),
    `status=${afterOne.status} attempts=${afterOne.attempts}/${afterOne.maxAttempts}, held until ${afterOne.runAfter.toISOString()}; worker reported ${firstPass.processed[0]?.outcome ?? "nothing"}`,
  );
  check(
    "The failure reason is retained on the job",
    Boolean(afterOne.error),
    afterOne.error?.slice(0, 90) ?? "no error recorded",
  );

  // Exhaust the attempts: force it runnable, drain again.
  await db
    .update(jobs)
    .set({ runAfter: new Date(Date.now() - 1000) })
    .where(eq(jobs.idempotencyKey, failKey));
  await runWorker({ maxJobs: 5 });
  const afterTwo = (
    await db.select().from(jobs).where(eq(jobs.idempotencyKey, failKey))
  )[0];
  check(
    "Exhausting maxAttempts marks the job failed",
    afterTwo.status === "failed" && afterTwo.attempts === 2,
    `status=${afterTwo.status} attempts=${afterTwo.attempts}/${afterTwo.maxAttempts}`,
  );

  // A failed job releases its key, so the planner can retry that work later.
  const reuse = await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: failKey,
    payload: { sleepMs: 0 },
  });
  check(
    "A failed job no longer reserves its idempotency key",
    reuse.created,
    reuse.created
      ? "re-enqueued the same key after failure, as SPEC 7.4 requires"
      : "the failed row still blocks the key",
  );

  // Unregistered type fails loudly rather than silently succeeding.
  await enqueue({
    workspaceId: ws.id,
    type: "does_not_exist",
    idempotencyKey: `${PREFIX}unknown`,
    payload: {},
    maxAttempts: 1,
  });
  await runWorker({ maxJobs: 5 });
  const unknown = (
    await db
      .select()
      .from(jobs)
      .where(eq(jobs.idempotencyKey, `${PREFIX}unknown`))
  )[0];
  check(
    "An unregistered job type fails with a clear message",
    unknown.status === "failed" && (unknown.error ?? "").includes("No handler"),
    unknown.error?.slice(0, 90) ?? "no error recorded",
  );

  // Stale lock recovery
  const staleKey = `${PREFIX}stale`;
  await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: staleKey,
    payload: { sleepMs: 0 },
  });
  await db
    .update(jobs)
    .set({
      status: "running",
      lockedAt: new Date(Date.now() - 60 * 60 * 1000),
      attempts: 1,
    })
    .where(eq(jobs.idempotencyKey, staleKey));
  const recovered = await recoverStaleJobs();
  const afterRecovery = (
    await db.select().from(jobs).where(eq(jobs.idempotencyKey, staleKey))
  )[0];
  check(
    "A job whose worker died is recovered, not stranded",
    recovered >= 1 && afterRecovery.status === "queued",
    `recovered ${recovered} job(s); the stranded job is now ${afterRecovery.status}`,
  );

  // ---------------------------------------------------------------- Phase 2
  section("Phase 2 — ingestion");

  const stored = await db
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, ws.id));

  check(
    "Domain crawled into sources",
    stored.length > 0,
    stored.length > 0
      ? `${stored.length} page(s) stored from ${ws.domain}`
      : "no sources — run a crawl from /sources first",
  );

  if (stored.length > 0) {
    check(
      "Every source carries a URL, content and a hash",
      stored.every(
        (s) => s.url && (s.rawText?.length ?? 0) > 0 && s.contentHash.length === 64,
      ),
      `all ${stored.length} rows have url, extracted text and a sha256 hash`,
    );

    const hashes = new Set(stored.map((s) => s.contentHash));
    check(
      "Content hashes are unique per workspace",
      hashes.size === stored.length,
      `${hashes.size} distinct hashes across ${stored.length} rows`,
    );

    /*
     * Re-crawl adds nothing: the acceptance check for this phase.
     *
     * Capped to a few pages deliberately. Proving the dedup only needs pages
     * that are already stored to come back as unchanged; refetching the whole
     * site to prove it turns the fast check into a multi-minute one, and it is
     * hostage to how quickly the target responds.
     */
    const recrawl = await crawlSite({
      workspaceId: ws.id,
      domain: ws.domain,
      maxPages: 3,
      budgetMs: 30_000,
    });
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sources)
      .where(eq(sources.workspaceId, ws.id));
    check(
      "Re-crawling adds nothing",
      recrawl.stored === 0 &&
        after[0].n === stored.length &&
        recrawl.duplicates > 0,
      `re-crawl of ${recrawl.visited} page(s) stored ${recrawl.stored}, matched ${recrawl.duplicates} unchanged; source count stayed at ${after[0].n}`,
    );
    check(
      "robots.txt was read and respected",
      !recrawl.robotsStatus.toLowerCase().includes("could not"),
      recrawl.robotsStatus,
    );
  }

  // Research dedup (SPEC section 5). Pure normalisation, so it runs without a
  // search provider configured and without touching the network.
  const spellings = [
    "Acme Corp alternatives",
    "  Acme   Corp   Alternatives?  ",
    "acme corp alternatives.",
    "ACME CORP ALTERNATIVES!!",
    "\tAcme\nCorp alternatives  ;",
  ];
  const normalised = new Set(spellings.map(normaliseQuery));
  const hashes = new Set(
    [...normalised].map((q) => hashQuery(q, "tavily")),
  );
  check(
    "Query spellings normalise to one cache key",
    normalised.size === 1 && hashes.size === 1,
    normalised.size === 1
      ? `5 spellings → "${[...normalised][0]}" → 1 hash`
      : `produced ${normalised.size} distinct queries: ${JSON.stringify([...normalised])}`,
  );

  // Idempotency scope: a completed job releases its key so work can re-run.
  const rerunKey = `${PREFIX}rerun`;
  await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: rerunKey,
    payload: { sleepMs: 0 },
  });
  await runWorker({ maxJobs: 5 });
  const rerun = await enqueue({
    workspaceId: ws.id,
    type: "noop",
    idempotencyKey: rerunKey,
    payload: { sleepMs: 0 },
  });
  check(
    "A completed job releases its key, so work can be re-run",
    rerun.created,
    rerun.created
      ? "re-enqueued after completion — required for re-crawl and for SPEC 7.2 re-compile"
      : "a done job still reserves the key, which would make re-compiling impossible",
  );

  // Cleanup
  const removed = await db
    .delete(jobs)
    .where(like(jobs.idempotencyKey, `${PREFIX}%`))
    .returning({ id: jobs.id });
  console.log(`\n(cleaned up ${removed.length} test job(s))`);

  console.log(
    `\n${failures === 0 ? `All ${checks} checks passed.` : `${failures} of ${checks} checks failed.`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
