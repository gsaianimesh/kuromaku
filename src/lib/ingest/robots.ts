import "server-only";
import robotsParser, { type Robot } from "robots-parser";
import { politeFetch, USER_AGENT } from "./fetch";

/**
 * robots.txt handling (SPEC 7.1: "Respect robots.txt").
 *
 * Fetch failures are not a licence to crawl freely, but they are also not a
 * reason to refuse: the convention is that a 404 means no restrictions, while a
 * 5xx or a network error means "unknown", and unknown is treated as disallowed
 * so we never hammer a site whose rules we could not read.
 */

export type RobotsPolicy = {
  origin: string;
  /** Null when robots.txt could not be read at all. */
  robots: Robot | null;
  /** Human-readable account of what happened, shown in the crawl log. */
  status: string;
  /** True when the fetch failed in a way that means we must not crawl. */
  blocked: boolean;
  sitemaps: string[];
  crawlDelayMs: number;
};

export async function loadRobots(origin: string): Promise<RobotsPolicy> {
  const url = new URL("/robots.txt", origin).toString();
  const res = await politeFetch(url, { accept: "text/plain", timeoutMs: 8000 });

  if (!res.ok) {
    // A 404 or 410 is the normal "no rules" case.
    if (res.status === 404 || res.status === 410) {
      return {
        origin,
        robots: null,
        status: `No robots.txt (HTTP ${res.status}) — no restrictions declared`,
        blocked: false,
        sitemaps: [],
        crawlDelayMs: 500,
      };
    }
    return {
      origin,
      robots: null,
      status: `Could not read robots.txt: ${res.error}. Treating as disallowed.`,
      blocked: true,
      sitemaps: [],
      crawlDelayMs: 500,
    };
  }

  const robots = robotsParser(url, res.body);
  const declaredDelay = robots.getCrawlDelay(USER_AGENT);

  return {
    origin,
    robots,
    status: `robots.txt read (${res.bytes} bytes)`,
    blocked: false,
    sitemaps: robots.getSitemaps(),
    // Honour a declared crawl-delay; otherwise stay polite by default.
    crawlDelayMs: Math.min(
      Math.max((declaredDelay ?? 0.5) * 1000, 250),
      10_000,
    ),
  };
}

export function isAllowed(policy: RobotsPolicy, url: string): boolean {
  if (policy.blocked) return false;
  if (!policy.robots) return true;
  // robots-parser returns undefined when it has no opinion, which means allowed.
  return policy.robots.isAllowed(url, USER_AGENT) !== false;
}
