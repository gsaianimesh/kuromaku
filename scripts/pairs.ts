/**
 * Before/after screenshot pairs for the submission document.
 *
 *   npm run dev      # terminal 1
 *   npm run pairs    # terminal 2
 *
 * A static document cannot show a transition, so each state change is captured
 * twice: the page before, then the same page after the change. The change is
 * always made through the real code path — `editRecord`, `runPlanner`,
 * `recordObservation` — never by writing the "after" state directly.
 *
 * Destructive: it edits memory, marks artifacts stale, and deletes and re-adds
 * observations. Run it against a database you are willing to have modified.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs", "images", "pairs");

const failures: string[] = [];

/** Full-page context shots compress well as JPEG; crops keep PNG for crisp text. */
async function shoot(
  page: Page,
  file: string,
  opts: { route: string; requires: string; crop?: string; mustContain?: string[] },
) {
  await page.goto(`${BASE}${opts.route}`, { waitUntil: "networkidle", timeout: 60_000 });

  try {
    await page.waitForSelector(opts.requires, { timeout: 20_000, state: "visible" });
  } catch {
    failures.push(`${file}: "${opts.requires}" never appeared on ${opts.route}.`);
    return false;
  }
  for (const text of opts.mustContain ?? []) {
    if ((await page.getByText(text, { exact: false }).count()) === 0) {
      failures.push(`${file}: expected text "${text}" missing on ${opts.route}.`);
      return false;
    }
  }

  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  if (opts.crop) {
    const el = page.locator(opts.crop).first();
    if ((await el.count()) === 0) {
      failures.push(`${file}: crop "${opts.crop}" matched nothing.`);
      return false;
    }
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await el.screenshot({ path: path.join(OUT, `${file}.png`) });
  } else {
    await page.screenshot({
      path: path.join(OUT, `${file}.jpg`),
      fullPage: true,
      type: "jpeg",
      quality: 82,
    });
  }
  console.log(`  ${file}`);
  return true;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const { getDb } = await import("../src/lib/db");
  const { and, eq, inArray, sql } = await import("drizzle-orm");
  const { artifactEvidence, artifacts, jobs, memoryRecords, observations } = await import(
    "../src/lib/db/schema"
  );
  const { getArtifact, listArtifacts } = await import("../src/lib/review");
  const { editRecord, downstreamOf } = await import("../src/lib/memory");
  const { recordObservation } = await import("../src/lib/publish");
  const { runPlanner } = await import("../src/lib/planner");
  const { getOrCreateDefaultWorkspace } = await import("../src/lib/workspace");

  const db = getDb();
  const ws = await getOrCreateDefaultWorkspace();

  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // ---------------------------------------------------------------- PAIR 1
  // A draft before a memory edit, and the same draft afterwards carrying the
  // stale banner that names what changed.
  console.log("\nPair 1: draft before and after a memory edit");

  /*
   * The draft has to cite records that are still active. A re-compile
   * supersedes records without marking derived artifacts stale — only a human
   * edit does that — so older drafts cite superseded rows, and editing those
   * is refused. Produce a fresh draft when none qualifies.
   */
  const activeIds = new Set(
    (
      await db
        .select({ id: memoryRecords.id })
        .from(memoryRecords)
        .where(eq(memoryRecords.status, "active"))
    ).map((r) => r.id),
  );

  const citesActive = (a: { evidence: Array<{ memoryRecordId: string | null }> }) =>
    a.evidence.some((e) => e.memoryRecordId && activeIds.has(e.memoryRecordId));

  let drafts = (await listArtifacts(ws.id, ["draft", "approved"])).filter(citesActive);

  if (drafts.length === 0 && process.env.PAIRS_ALLOW_AGENT !== "1") {
    failures.push(
      "Pair 1: no draft cites an active memory record. Re-run with PAIRS_ALLOW_AGENT=1 " +
        "to produce one (costs an agent run, which may wait out a rate limit).",
    );
  } else if (drafts.length === 0) {
    console.log("    no draft cites an active record; running an agent to make one");
    const { enqueue } = await import("../src/lib/jobs/queue");
    const { runWorker } = await import("../src/lib/jobs/worker");
    await db.delete(jobs).where(eq(jobs.type, "run_agent"));
    await enqueue({
      workspaceId: ws.id,
      type: "run_agent",
      idempotencyKey: `pairs:${Date.now()}`,
      payload: { agentId: "launch_community", channel: "hacker_news", locale: "en" },
      reason:
        "Channel ranked 1 in the compiled strategy. Launch and community agent covers it.",
      maxAttempts: 1,
    });
    const res = await runWorker({ maxJobs: 1, budgetMs: 600_000 });
    console.log(`    agent: ${res.processed[0]?.outcome ?? "no job"}`);
    drafts = (await listArtifacts(ws.id, ["draft", "approved"])).filter(citesActive);
  }

  const target = drafts[0];
  if (!target) {
    failures.push(
      "Pair 1: no draft cites an active memory record, and the agent run did not produce one.",
    );
  } else {
    await shoot(page, "1a-draft-before", {
      route: "/review",
      requires: `section:has-text('${target.kind}')`,
      crop: "section:has(p:text-is('Evidence'))",
    });

    // The real edit path. Pick the deepest-rooted cited record so the "after"
    // demonstrates multi-hop propagation rather than a direct citation.
    const cited = target.evidence.filter(
      (e) => e.memoryRecordId && activeIds.has(e.memoryRecordId),
    );
    let chosen = cited[0];
    let bestDepth = -1;
    for (const c of cited) {
      const down = await downstreamOf(c.memoryRecordId!);
      if (down.length > bestDepth) {
        bestDepth = down.length;
        chosen = c;
      }
    }
    console.log(`    editing a record with ${bestDepth} record(s) downstream`);

    const [rec] = await db
      .select()
      .from(memoryRecords)
      .where(eq(memoryRecords.id, chosen.memoryRecordId!))
      .limit(1);

    const value = rec.value as Record<string, unknown>;
    const { staleArtifactIds, affectedRecordIds } = await editRecord(
      rec.id,
      { ...value, correctedByHuman: true, note: "Corrected during review." },
      0.95,
    );
    console.log(
      `    edited ${rec.type}:${rec.key} -> ${affectedRecordIds.length} record(s) downstream, ${staleArtifactIds.length} artifact(s) stale`,
    );

    await shoot(page, "1b-draft-after-stale", {
      route: "/review",
      requires: "div:has-text('Stale.')",
      crop: "div.border-warn\\/40",
      mustContain: ["Stale."],
    });
    await shoot(page, "1b-review-after-full", {
      route: "/review",
      requires: "h1",
    });
  }

  // ---------------------------------------------------------------- PAIR 2
  // The version chain: the superseded version and the active one, so the change
  // itself is legible.
  console.log("\nPair 2: version history, superseded and active");

  const [versioned] = await db
    .select()
    .from(memoryRecords)
    .where(and(eq(memoryRecords.status, "active"), sql`${memoryRecords.version} > 1`))
    .orderBy(sql`${memoryRecords.version} desc`)
    .limit(1);

  if (!versioned) {
    failures.push("Pair 2: no record past version 1.");
  } else {
    await shoot(page, "2a-history-superseded", {
      route: `/memory/${versioned.id}`,
      requires: "li:has-text('superseded')",
      crop: "li:has-text('superseded')",
    });
    await shoot(page, "2b-history-active", {
      route: `/memory/${versioned.id}`,
      requires: "li:has-text('active')",
      crop: "li.border-ok\\/30",
    });
    await shoot(page, "2c-history-full", {
      route: `/memory/${versioned.id}`,
      requires: "h1",
      mustContain: ["Version history"],
    });
  }

  // ---------------------------------------------------------------- PAIR 5
  // Evidence panel, then the record page a reader lands on after clicking one
  // of those links. Captured before the planner pair because it reads state
  // the planner pair then changes.
  console.log("\nPair 5: evidence link, and where it lands");

  const anyArtifact = (await listArtifacts(ws.id)).find((a) =>
    a.evidence.some((e) => e.memoryRecordId),
  );
  if (!anyArtifact) {
    failures.push("Pair 5: no artifact cites a memory record.");
  } else {
    const link = anyArtifact.evidence.find((e) => e.memoryRecordId)!;
    await shoot(page, "5a-evidence-panel", {
      route: "/review",
      requires: "p:text-is('Evidence')",
      crop: "div:has(> p:text-is('Evidence'))",
    });
    await shoot(page, "5b-record-landed", {
      route: `/memory/${link.memoryRecordId}`,
      requires: "h1",
      mustContain: ["Version history"],
    });
  }

  // ---------------------------------------------------------------- PAIR 4
  // The performance panel with nothing measured, and after an observation.
  console.log("\nPair 4: performance panel, empty and populated");

  const published = (await listArtifacts(ws.id, ["published"]))[0];
  if (!published) {
    failures.push("Pair 4: no published artifact to attach an observation to.");
  } else {
    const saved = await db
      .select()
      .from(observations)
      .where(eq(observations.workspaceId, ws.id));

    await db.delete(observations).where(eq(observations.workspaceId, ws.id));
    await shoot(page, "4a-performance-empty", {
      route: "/metrics",
      requires: "section:has(h2:text-is('Observations'))",
      crop: "section:has(h2:text-is('Observations'))",
      mustContain: ["No performance has been observed yet"],
    });

    /*
     * Restore what was there, minus this pair's own observation from an earlier
     * run. Restoring everything and then adding another meant the "after" shot
     * grew a row per run: five identical upvote entries under a caption that
     * says "a single observation", which reads exactly like the duplicate
     * execution defect this project was built to answer.
     */
    const isOurs = (o: (typeof saved)[number]) =>
      o.artifactId === published.id &&
      o.metric === "upvotes" &&
      Number(o.value) === 42 &&
      o.source === "manual";

    for (const o of saved.filter((o) => !isOurs(o))) {
      await recordObservation({
        workspaceId: ws.id,
        artifactId: o.artifactId,
        metric: o.metric,
        value: Number(o.value),
        source: o.source as "manual" | "gsc" | "import",
        observedAt: o.observedAt,
      });
    }
    await recordObservation({
      workspaceId: ws.id,
      artifactId: published.id,
      metric: "upvotes",
      value: 42,
      source: "manual",
    });

    await shoot(page, "4b-performance-recorded", {
      route: "/metrics",
      requires: "table tbody tr",
      crop: "section:has(h2:text-is('Observations'))",
    });
  }

  // ---------------------------------------------------------------- PAIR 3
  // The planner scheduling a channel, then declining to schedule it once its
  // recent drafts have gone unmeasured. Runs last because it depends on the
  // observation state the previous pair settles.
  console.log("\nPair 3: planner scheduling, then gating the same channel");

  await db.delete(jobs).where(eq(jobs.type, "run_agent"));
  const first = await runPlanner(ws.id, () => {});

  /*
   * The gate fires only on a channel whose recent artifacts have *no*
   * observations. Pair 4 records one against the published artifact's channel,
   * so that channel is legitimately not gated. Pick one that is unmeasured.
   */
  const observedChannels = new Set(
    (
      await db
        .selectDistinct({ channel: artifacts.channel })
        .from(observations)
        .innerJoin(artifacts, eq(observations.artifactId, artifacts.id))
        .where(eq(observations.workspaceId, ws.id))
    ).map((r) => r.channel),
  );
  const scheduledChannel = first.scheduled
    .map((s) => s.channel)
    .find((c) => !observedChannels.has(c));
  console.log(
    `    channels with observations: ${[...observedChannels].join(", ") || "none"}; gating "${scheduledChannel ?? "none available"}"`,
  );
  console.log(
    `    scheduled ${first.scheduled.length}: ${first.scheduled.map((s) => s.channel).join(", ") || "none"}`,
  );

  await shoot(page, "3a-planner-scheduled", {
    route: "/planner",
    requires: "section:has(h2:text-is('Scheduled work'))",
    crop: "section:has(h2:text-is('Scheduled work'))",
  });

  if (!scheduledChannel) {
    failures.push("Pair 3: the planner scheduled nothing, so there is no before state.");
  } else {
    /*
     * Two unmeasured drafts in that channel is the condition the gate looks
     * for. These are fixtures, not agent output, so they get evidence like any
     * real draft would: writing them bare left rows in the review queue that
     * the interface correctly flagged as impossible, and one of those rows
     * reached a screenshot. They are deleted again once the pair is captured.
     */
    const [citable] = await db
      .select({ id: memoryRecords.id })
      .from(memoryRecords)
      .where(and(eq(memoryRecords.workspaceId, ws.id), eq(memoryRecords.status, "active")))
      .limit(1);

    const fixtures = await db
      .insert(artifacts)
      .values(
        [1, 2].map((i) => ({
          workspaceId: ws.id,
          channel: scheduledChannel,
          agentId: "launch_community",
          kind: "post",
          status: "draft" as const,
          content: `Draft ${i} for ${scheduledChannel}, awaiting performance data.`,
          locale: "en",
        })),
      )
      .returning({ id: artifacts.id });

    await db.insert(artifactEvidence).values(
      fixtures.map((f) => ({
        artifactId: f.id,
        memoryRecordId: citable?.id ?? null,
        note: "Planner fixture for the unmeasured-channel gate.",
      })),
    );
    await db.delete(jobs).where(eq(jobs.type, "run_agent"));

    const second = await runPlanner(ws.id, () => {});
    const gated = second.skipped.find((s) => s.channel === scheduledChannel);
    console.log(`    gated: ${gated ? gated.why.slice(0, 80) : "NOT GATED"}`);
    if (!gated) {
      failures.push(
        `Pair 3: ${scheduledChannel} was not gated on the second run, so there is no after state.`,
      );
    }

    // The skip reason lives in the "Run planner now" result panel, so drive the
    // button rather than reading it from the page's server render.
    await page.goto(`${BASE}/planner`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /run planner now/i }).click();
    await page.waitForSelector("text=/skip /", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const panel = page.locator("section:has(h2:text-is('Run planner'))").first();
    await panel.screenshot({ path: path.join(OUT, "3b-planner-gated.png") });
    console.log("  3b-planner-gated");

    await shoot(page, "3c-planner-full", {
      route: "/planner",
      requires: "table tbody tr",
    });

    // The fixtures existed to create a planner condition, not to be reviewed.
    // Leaving them behind pollutes the review queue in every later capture.
    await db.delete(artifacts).where(
      inArray(
        artifacts.id,
        fixtures.map((f) => f.id),
      ),
    );
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} pair shot(s) could not be captured honestly:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nPairs written to docs/images/pairs/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
