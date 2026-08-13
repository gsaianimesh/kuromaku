/**
 * Phase 0 acceptance checks, runnable headlessly against the real database.
 *
 *   npm run verify
 *
 * Proves: migrations are applied, and a BYOK key survives a full
 * encrypt → Postgres → decrypt round trip. Restores any pre-existing key so
 * running this is non-destructive.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { eq } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { settings } from "../src/lib/db/schema";
import { runHealthChecks } from "../src/lib/health";
import { getKeyStatus, saveModelKey } from "../src/lib/settings";
import { getOrCreateDefaultWorkspace } from "../src/lib/workspace";

let failures = 0;

function report(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
}

async function main() {
  console.log("Phase 0 acceptance checks\n");

  const health = await runHealthChecks();
  for (const c of health.checks) {
    report(c.label, c.status === "pass", c.detail);
  }

  const ws = await getOrCreateDefaultWorkspace();
  report(
    "Workspace bootstrap",
    Boolean(ws?.id),
    `${ws.name} (${ws.domain}) — ${ws.id}`,
  );

  // Snapshot so we can restore whatever was there before.
  const db = getDb();
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

    report(
      "Key is ciphertext at rest",
      Boolean(stored?.k) && !stored!.k!.includes(probe),
      `column holds a ${stored?.k?.length ?? 0}-char envelope, not the plaintext`,
    );

    const status = await getKeyStatus(ws.id);
    report(
      "Key round trip (encrypt → Postgres → decrypt)",
      status.state === "stored" && status.masked.endsWith(probe.slice(-4)),
      status.state === "stored"
        ? `read back and decrypted; tail matches (${status.masked})`
        : `unexpected state: ${status.state}`,
    );
  } finally {
    // Restore prior state exactly.
    await db
      .update(settings)
      .set({
        encryptedModelKey: before?.k ?? null,
        modelProvider: before?.p ?? "groq",
      })
      .where(eq(settings.workspaceId, ws.id));
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
