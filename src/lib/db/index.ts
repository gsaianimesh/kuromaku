import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getEnv } from "../env";
import * as schema from "./schema";

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazily constructed so an unset DATABASE_URL surfaces as a readable error on
 * /health instead of crashing at module-import time.
 */
export function getDb() {
  if (cached) return cached;
  const sql = neon(getEnv().DATABASE_URL);
  cached = drizzle(sql, { schema });
  return cached;
}

export { schema };
