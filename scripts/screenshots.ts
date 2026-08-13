/**
 * Documentation screenshots.
 *
 *   npm run dev            # in one terminal
 *   npm run screenshots    # in another
 *
 * Captures the real application against the real database and writes PNGs to
 * docs/images/. Nothing here fabricates a page: every shot navigates to a route
 * the app actually serves, waits for a selector proving the expected content
 * rendered, and fails loudly if that content is absent rather than capturing an
 * empty state and passing it off as the real thing.
 *
 * Shots are regenerable: re-run it after a UI change and the docs update.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs", "images");

/** 1440x900 at 2x, per the documentation style. */
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

type Shot = {
  file: string;
  route: string;
  /** Must be present before capturing — proves the page has the real content. */
  requires: string;
  /** Optional: capture only this element rather than the full page. */
  crop?: string;
  /** Text that must appear somewhere, as a second guard against an empty state. */
  mustContain?: string[];
  fullPage?: boolean;
  /** Elements to open before capturing (details/summary toggles). */
  expand?: string;
  note: string;
};

const failures: string[] = [];

async function capture(page: Page, shot: Shot) {
  const url = `${BASE}${shot.route}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

  // Guard 1: the selector that proves this page rendered its real content.
  try {
    await page.waitForSelector(shot.requires, { timeout: 20_000, state: "visible" });
  } catch {
    failures.push(
      `${shot.file}: "${shot.requires}" never appeared on ${shot.route}. ` +
        `The state this shot documents does not exist — seed it and re-run rather than capturing a placeholder.`,
    );
    return;
  }

  // Guard 2: expected text. Catches a page that rendered its shell but has no data.
  for (const text of shot.mustContain ?? []) {
    const found = await page.getByText(text, { exact: false }).count();
    if (found === 0) {
      failures.push(
        `${shot.file}: expected text "${text}" not found on ${shot.route}. Refusing to capture.`,
      );
      return;
    }
  }

  if (shot.expand) {
    for (const el of await page.locator(shot.expand).all()) {
      await el.evaluate((node) => {
        const details = node.closest("details");
        if (details) details.open = true;
      });
    }
    await page.waitForTimeout(250);
  }

  // Fonts and any late layout settle before the shot.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const target: Page | Locator = shot.crop ? page.locator(shot.crop).first() : page;
  const file = path.join(OUT, shot.file);

  if (shot.crop) {
    const locator = target as Locator;
    if ((await locator.count()) === 0) {
      failures.push(`${shot.file}: crop selector "${shot.crop}" matched nothing.`);
      return;
    }
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await locator.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: shot.fullPage ?? true });
  }

  console.log(`  ${shot.file.padEnd(34)} ${shot.note}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Deep-link ids are resolved from the database so the script stays correct as
  // data changes, rather than hard-coding a uuid that will rot.
  const { getDb } = await import("../src/lib/db");
  const { and, desc, eq, sql } = await import("drizzle-orm");
  const { artifacts, jobs, memoryRecords, agentRuns } = await import(
    "../src/lib/db/schema"
  );
  const db = getDb();

  const [runJob] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(agentRuns, eq(agentRuns.jobId, jobs.id))
    .groupBy(jobs.id)
    .orderBy(desc(sql`count(${agentRuns.id})`))
    .limit(1);

  const [versioned] = await db
    .select({ id: memoryRecords.id })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.status, "active"), sql`${memoryRecords.version} > 1`))
    .limit(1);

  const [staleArtifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.status, "stale"))
    .limit(1);

  if (!runJob) failures.push("No job has model calls — the run inspector shot needs one.");
  if (!versioned) failures.push("No memory record past version 1 — the history shot needs one.");
  if (!staleArtifact) failures.push("No stale artifact — the stale banner shot needs one.");

  const shots: Shot[] = [
    {
      file: "sources.png",
      route: "/sources",
      requires: "table tbody tr",
      mustContain: ["Stored pages"],
      note: "crawled pages with content hashes",
    },
    {
      file: "memory-full.png",
      route: "/memory",
      requires: "h1",
      mustContain: ["Memory", "Product facts"],
      note: "memory browser grouped by type",
    },
    {
      file: "memory-record-sourced.png",
      route: "/memory",
      requires: "li:has(a[href^='http'])",
      crop: "section:has(h2:text-is('Product facts')) li:has(a[href^='http'])",
      note: "one record with its source link, snippet and confidence",
    },
    {
      file: "memory-unsourced.png",
      route: "/memory",
      requires: "li:has-text('No source.')",
      crop: "li:has-text('No source.')",
      mustContain: ["No source."],
      note: "an unsourced record with its warning",
    },
    {
      file: "memory-history.png",
      route: `/memory/${versioned?.id ?? ""}`,
      requires: "li:has-text('superseded')",
      mustContain: ["Version history", "superseded", "active"],
      note: "version chain: superseded versions and the active one",
    },
    {
      file: "review-full.png",
      route: "/review",
      requires: "h1",
      mustContain: ["Review queue"],
      note: "the review queue",
    },
    {
      file: "review-evidence.png",
      route: "/review",
      requires: "p:text-is('Evidence')",
      crop: "div:has(> p:text-is('Evidence'))",
      note: "an evidence panel with clickable record links",
    },
    {
      file: "review-stale-banner.png",
      route: "/review",
      requires: "div:has-text('Stale.')",
      crop: "div.border-warn\\/40",
      mustContain: ["Stale."],
      note: "the stale banner naming the superseded record",
    },
    {
      file: "review-critic.png",
      route: "/review",
      requires: "p:text-is('Critic')",
      // The whole card, so the score badge in the header and the named
      // violations in the body appear in one image.
      crop: "section:has(p:text-is('Critic'))",
      note: "critic score with named violations",
    },
    {
      file: "planner-full.png",
      route: "/planner",
      requires: "table tbody tr",
      mustContain: ["Planner", "Channel priorities vs agent coverage"],
      note: "channel priorities against agent coverage",
    },
    {
      file: "planner-gaps.png",
      route: "/planner",
      requires: "section:has(h2:text-is('Coverage gaps'))",
      crop: "section:has(h2:text-is('Coverage gaps'))",
      mustContain: ["no agent"],
      note: "coverage gaps: prioritised channels with no agent",
    },
    {
      file: "planner-reason.png",
      route: "/planner",
      requires: "section:has(h2:text-is('Scheduled work'))",
      crop: "section:has(h2:text-is('Scheduled work'))",
      note: "a scheduled job with its plain-language reason",
    },
    {
      file: "job-inspector.png",
      route: `/jobs/${runJob?.id ?? ""}`,
      requires: "section:has(h2:text-is('Model calls'))",
      mustContain: ["Model calls", "tokens"],
      expand: "details summary",
      note: "run inspector: prompt, model, tokens, cost",
    },
    {
      file: "job-inspector-call.png",
      route: `/jobs/${runJob?.id ?? ""}`,
      requires: "section:has(h2:text-is('Model calls')) li",
      crop: "section:has(h2:text-is('Model calls')) li",
      note: "a single logged model call",
    },
    {
      file: "metrics.png",
      route: "/metrics",
      requires: "svg[role='img']",
      mustContain: ["Edit distance per agent over time"],
      note: "edit distance chart with real points",
    },
    {
      file: "metrics-chart.png",
      route: "/metrics",
      requires: "svg[role='img']",
      crop: "section:has(h2:text-is('Edit distance per agent over time'))",
      note: "the chart on its own",
    },
    {
      file: "publish.png",
      route: "/publish",
      requires: "button:has-text('copy to clipboard')",
      mustContain: ["How publishing works here"],
      note: "copy-and-confirm publishing flow",
    },
    {
      file: "jobs.png",
      route: "/jobs",
      requires: "table tbody tr",
      mustContain: ["Queue"],
      note: "the job queue",
    },
    {
      file: "settings.png",
      route: "/settings",
      requires: "h1",
      mustContain: ["Settings", "Model key"],
      note: "settings — the key must render masked, never in full",
    },
  ];

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  console.log(`Capturing ${shots.length} shots from ${BASE}\n`);
  for (const shot of shots) {
    if (shot.route.endsWith("/")) {
      failures.push(`${shot.file}: no id resolved for ${shot.route}`);
      continue;
    }
    await capture(page, shot);
  }

  // A key must never be legible in a committed image.
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  const body = (await page.textContent("body")) ?? "";
  const leaked = [/gsk_[A-Za-z0-9]{20,}/, /tvly-[A-Za-z0-9-]{20,}/, /sk-ant-[A-Za-z0-9-]{20,}/]
    .map((re) => body.match(re)?.[0])
    .filter(Boolean);
  if (leaked.length > 0) {
    failures.push(
      `SECURITY: /settings rendered what looks like a real key (${leaked[0]!.slice(0, 8)}…). ` +
        `Change the seeded value — do not edit the image.`,
    );
  } else {
    console.log("\n  /settings renders no full key — masked display confirmed.");
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} shot(s) could not be captured honestly:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nAll ${shots.length} shots written to docs/images/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
