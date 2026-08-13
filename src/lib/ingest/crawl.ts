import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { sources } from "../db/schema";
import { extract, extractSitemapUrls } from "./extract";
import { politeFetch, sleep } from "./fetch";
import { isAllowed, loadRobots, type RobotsPolicy } from "./robots";

/**
 * Domain crawl (SPEC 7.1). Sitemap first when one is declared, breadth-first
 * from the root otherwise. Bounded, same-origin, robots-respecting, and
 * deduplicated by content hash so a re-crawl of unchanged pages stores nothing.
 */

export const DEFAULT_MAX_PAGES = 30;

export type CrawlOptions = {
  workspaceId: string;
  domain: string;
  maxPages?: number;
  /** Stop starting new fetches past this budget, so a job cannot run forever. */
  budgetMs?: number;
  log?: (message: string) => void;
};

export type CrawlSummary = {
  origin: string;
  robotsStatus: string;
  discovery: "sitemap" | "crawl" | "none";
  visited: number;
  stored: number;
  duplicates: number;
  skipped: Array<{ url: string; reason: string }>;
  stoppedEarly: string | null;
};

/** Accepts "example.com", "https://example.com/path" and anything between. */
export function toOrigin(domain: string): string {
  const trimmed = domain.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).origin;
}

/** Same page, different URL spelling: drop the fragment, trailing slash, and common tracking params. */
function canonicalise(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|mc_)/i.test(p)) u.searchParams.delete(p);
    }
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Obvious non-documents, filtered before spending a request on them. */
const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|tar|mp4|mp3|wav|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i;

function crawlable(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return false;
    if (SKIP_EXT.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function collectFromSitemaps(
  policy: RobotsPolicy,
  origin: string,
  maxPages: number,
  log: (m: string) => void,
): Promise<string[]> {
  // Try declared sitemaps first, then the conventional location.
  const queue = [...policy.sitemaps];
  if (queue.length === 0) queue.push(new URL("/sitemap.xml", origin).toString());

  const found: string[] = [];
  const seenSitemaps = new Set<string>();

  while (queue.length > 0 && found.length < maxPages * 3) {
    const sm = queue.shift()!;
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);

    const res = await politeFetch(sm, {
      accept: "application/xml,text/xml",
      timeoutMs: 8000,
    });
    if (!res.ok) {
      log(`sitemap ${sm}: ${res.error}`);
      continue;
    }

    const { pages, sitemaps } = extractSitemapUrls(res.body);
    log(`sitemap ${sm}: ${pages.length} urls, ${sitemaps.length} nested`);
    for (const p of pages) {
      const c = canonicalise(p);
      if (c && crawlable(c, origin)) found.push(c);
    }
    // Bound how deep a sitemap index can send us.
    if (seenSitemaps.size < 5) queue.push(...sitemaps);
  }

  return [...new Set(found)];
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlSummary> {
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const budgetMs = opts.budgetMs ?? 45_000;
  const startedAt = Date.now();
  const db = getDb();

  const origin = toOrigin(opts.domain);
  log(`crawl target ${origin}, max ${maxPages} pages`);

  const policy = await loadRobots(origin);
  log(policy.status);

  const summary: CrawlSummary = {
    origin,
    robotsStatus: policy.status,
    discovery: "none",
    visited: 0,
    stored: 0,
    duplicates: 0,
    skipped: [],
    stoppedEarly: null,
  };

  if (policy.blocked) {
    summary.stoppedEarly =
      "robots.txt could not be read, so the crawl was not started.";
    log(summary.stoppedEarly);
    return summary;
  }

  // Existing hashes for this workspace, so duplicates are counted rather than
  // silently swallowed by the unique index.
  const existing = new Set(
    (
      await db
        .select({ h: sources.contentHash })
        .from(sources)
        .where(eq(sources.workspaceId, opts.workspaceId))
    ).map((r) => r.h),
  );
  log(`${existing.size} source(s) already stored for this workspace`);

  // Build the frontier.
  const sitemapUrls = await collectFromSitemaps(policy, origin, maxPages, log);
  const queue: string[] = [];
  const seen = new Set<string>();

  if (sitemapUrls.length > 0) {
    summary.discovery = "sitemap";
    for (const u of sitemapUrls) {
      if (!seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    }
    log(`discovery: sitemap, ${queue.length} candidate url(s)`);
  } else {
    summary.discovery = "crawl";
    const root = canonicalise(origin)!;
    seen.add(root);
    queue.push(root);
    log("discovery: no usable sitemap, breadth-first from the root");
  }

  while (queue.length > 0 && summary.stored + summary.duplicates < maxPages) {
    if (Date.now() - startedAt > budgetMs) {
      summary.stoppedEarly = `Stopped after ${Math.round((Date.now() - startedAt) / 1000)}s to stay inside the job budget. Re-run to continue.`;
      log(summary.stoppedEarly);
      break;
    }

    const url = queue.shift()!;

    if (!isAllowed(policy, url)) {
      summary.skipped.push({ url, reason: "disallowed by robots.txt" });
      continue;
    }

    const res = await politeFetch(url, { timeoutMs: 10_000 });
    summary.visited++;

    if (!res.ok) {
      summary.skipped.push({ url, reason: res.error });
      log(`skip ${url}: ${res.error}`);
      await sleep(policy.crawlDelayMs);
      continue;
    }

    if (!/html|xml/i.test(res.contentType)) {
      summary.skipped.push({ url, reason: `content type ${res.contentType}` });
      await sleep(policy.crawlDelayMs);
      continue;
    }

    const doc = extract(res.body, res.url);

    // Very short pages are usually redirects, error shells or JS-only routes.
    if (doc.text.length < 120) {
      summary.skipped.push({
        url,
        reason: `only ${doc.text.length} characters of text extracted`,
      });
      log(`skip ${url}: too little text (${doc.text.length} chars)`);
      await sleep(policy.crawlDelayMs);
      continue;
    }

    if (existing.has(doc.contentHash)) {
      summary.duplicates++;
      log(`unchanged ${url} (hash ${doc.contentHash.slice(0, 12)})`);
    } else {
      const [row] = await db
        .insert(sources)
        .values({
          workspaceId: opts.workspaceId,
          url: res.url,
          kind: "page",
          title: doc.title,
          rawText: doc.text,
          contentHash: doc.contentHash,
        })
        .onConflictDoNothing()
        .returning({ id: sources.id });

      if (row) {
        existing.add(doc.contentHash);
        summary.stored++;
        log(
          `stored ${url} — "${doc.title ?? "(untitled)"}" (${doc.text.length} chars)`,
        );
      } else {
        // Lost a race with a concurrent crawl of the same content.
        summary.duplicates++;
      }
    }

    // Only breadth-first discovery needs to expand the frontier.
    if (summary.discovery === "crawl") {
      for (const link of doc.links) {
        const c = canonicalise(link);
        if (!c || seen.has(c) || !crawlable(c, origin)) continue;
        seen.add(c);
        queue.push(c);
      }
    }

    await sleep(policy.crawlDelayMs);
  }

  if (
    !summary.stoppedEarly &&
    summary.stored + summary.duplicates >= maxPages &&
    queue.length > 0
  ) {
    summary.stoppedEarly = `Reached the ${maxPages} page cap with ${queue.length} url(s) still queued.`;
  }

  log(
    `done: ${summary.stored} stored, ${summary.duplicates} unchanged, ${summary.skipped.length} skipped, ${summary.visited} fetched`,
  );
  return summary;
}
