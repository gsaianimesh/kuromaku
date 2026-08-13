import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { checkEnv } from "./env";
import { decryptSecret, encryptSecret, secretsMatch } from "./crypto";

export type CheckStatus = "pass" | "fail" | "warn";

export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Milliseconds, measured. Absent when the check did not run. */
  durationMs?: number;
};

export type HealthReport = {
  status: CheckStatus;
  checkedAt: string;
  checks: Check[];
};

/** Tables the current phase expects to exist. Grows with each phase. */
const EXPECTED_TABLES = [
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

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, Math.round(performance.now() - t0)];
}

export async function runHealthChecks(): Promise<HealthReport> {
  const checks: Check[] = [];

  // 1. Environment
  const env = checkEnv();
  checks.push({
    id: "env",
    label: "Environment variables",
    status: env.ok ? "pass" : "fail",
    detail: env.ok
      ? "DATABASE_URL and APP_ENCRYPTION_KEY present and well formed"
      : env.missing.join("; "),
  });

  if (!env.ok) {
    return {
      status: "fail",
      checkedAt: new Date().toISOString(),
      checks: [
        ...checks,
        {
          id: "db",
          label: "Database connection",
          status: "fail",
          detail: "Skipped — environment is invalid",
        },
        {
          id: "migrations",
          label: "Migrations",
          status: "fail",
          detail: "Skipped — environment is invalid",
        },
        {
          id: "crypto",
          label: "Encryption round trip",
          status: "fail",
          detail: "Skipped — environment is invalid",
        },
      ],
    };
  }

  // 2. Database connectivity
  let dbUp = false;
  try {
    const [row, ms] = await timed(async () => {
      const db = getDb();
      const r = await db.execute<{ version: string }>(
        sql`select version() as version`,
      );
      return r.rows[0];
    });
    dbUp = true;
    checks.push({
      id: "db",
      label: "Database connection",
      status: "pass",
      detail: row?.version?.split(" ").slice(0, 2).join(" ") ?? "connected",
      durationMs: ms,
    });
  } catch (e) {
    checks.push({
      id: "db",
      label: "Database connection",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Migration state
  if (dbUp) {
    try {
      const [detail, ms] = await timed(async () => {
        const db = getDb();
        const present = await db.execute<{ table_name: string }>(sql`
          select table_name from information_schema.tables
          where table_schema = 'public'
        `);
        const names = new Set(present.rows.map((r) => r.table_name));
        const missing = EXPECTED_TABLES.filter((t) => !names.has(t));

        const applied = await db.execute<{ n: string }>(sql`
          select count(*)::text as n from drizzle.__drizzle_migrations
        `);
        return {
          missing,
          applied: Number(applied.rows[0]?.n ?? 0),
          total: names.size,
        };
      });
      checks.push({
        id: "migrations",
        label: "Migrations",
        status: detail.missing.length === 0 ? "pass" : "fail",
        detail:
          detail.missing.length === 0
            ? `${detail.applied} applied · ${EXPECTED_TABLES.length}/${EXPECTED_TABLES.length} expected tables present`
            : `Missing tables: ${detail.missing.join(", ")} — run \`npm run db:migrate\``,
        durationMs: ms,
      });
    } catch (e) {
      checks.push({
        id: "migrations",
        label: "Migrations",
        status: "fail",
        detail:
          e instanceof Error && e.message.includes("__drizzle_migrations")
            ? "No migrations have been applied — run `npm run db:migrate`"
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  } else {
    checks.push({
      id: "migrations",
      label: "Migrations",
      status: "fail",
      detail: "Skipped — no database connection",
    });
  }

  // 4. Encryption round trip. Uses a throwaway probe value, never a real key.
  try {
    const probe = `probe-${Math.random().toString(36).slice(2)}`;
    const restored = decryptSecret(encryptSecret(probe));
    const ok = secretsMatch(probe, restored);
    checks.push({
      id: "crypto",
      label: "Encryption round trip",
      status: ok ? "pass" : "fail",
      detail: ok
        ? "AES-256-GCM encrypt → decrypt returned the original value"
        : "Decrypted value did not match the original",
    });
  } catch (e) {
    checks.push({
      id: "crypto",
      label: "Encryption round trip",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const status: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";

  return { status, checkedAt: new Date().toISOString(), checks };
}
