import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getEnv } from "../env";
import * as schema from "./schema";

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Retries a query whose HTTP request never completed.
 *
 * Neon's HTTP endpoint intermittently fails at the transport layer — undici
 * throws `TypeError: fetch failed` and the driver surfaces it as
 * "Error connecting to database". A single blip like that was enough to take
 * down a whole page render, which is not an acceptable failure mode for a
 * transient network fault.
 *
 * Only a *thrown* fetch is retried, never an HTTP error response: a throw means
 * no response headers ever arrived, so the query almost certainly never reached
 * Postgres. The narrow exception is a request that was processed and whose
 * response was lost in flight — retrying that could re-apply a write. Two
 * retries with short backoff is the deliberate trade: the failure being fixed
 * is common and total, the one being risked is rare and partial.
 */
async function retryingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(input, init);
    } catch (e) {
      lastError = e;
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 150 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/**
 * Lazily constructed so an unset DATABASE_URL surfaces as a readable error on
 * /health instead of crashing at module-import time.
 */
export function getDb() {
  if (cached) return cached;
  // `fetchFunction` is global-only config on the Neon driver, not a per-call
  // option, so it is set here rather than passed to neon().
  neonConfig.fetchFunction = retryingFetch;
  const sql = neon(getEnv().DATABASE_URL);
  cached = drizzle(sql, { schema });
  return cached;
}

export { schema };
