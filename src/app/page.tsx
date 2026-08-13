import Link from "next/link";
import { Badge, Panel, Row, StatusDot, type StatusTone } from "@/components/ui";
import { runHealthChecks } from "@/lib/health";
import { getKeyStatus } from "@/lib/settings";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Build status is derived from what actually exists in the repo, updated as
 * each phase lands. Nothing here is a measured metric — the metrics dashboard
 * arrives in Phase 5 and will show empty states until observations exist.
 */
const PHASES = [
  { n: 0, name: "Scaffold, BYOK, health", state: "done" },
  { n: 1, name: "Schema and job queue", state: "done" },
  { n: 2, name: "Ingestion", state: "next" },
  { n: 3, name: "Strategy compiler", state: "todo" },
  { n: 4, name: "Memory viewer, staleness", state: "todo" },
  { n: 5, name: "Community agent, critic, review queue", state: "todo" },
  { n: 6, name: "Planner and coverage gaps", state: "todo" },
  { n: 7, name: "Publishing and performance", state: "todo" },
  { n: 8, name: "Content agent, REST, MCP", state: "todo" },
  { n: 9, name: "Demo and docs", state: "todo" },
] as const;

export default async function Home() {
  const ws = await getOrCreateDefaultWorkspace();
  const [health, key] = await Promise.all([
    runHealthChecks(),
    getKeyStatus(ws.id),
  ]);

  const healthTone: StatusTone =
    health.status === "pass" ? "ok" : health.status === "warn" ? "warn" : "bad";

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div>
        <h1 className="text-[15px] font-medium">Kuromaku</h1>
        <p className="text-[12px] text-muted mt-0.5 max-w-2xl">
          A versioned marketing memory. Every fact carries provenance, editing a
          record invalidates everything derived from it, and the agent set is
          derived from the strategy rather than fixed.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Panel
          title="System"
          actions={
            <Link href="/health" className="text-[11px] text-accent hover:underline">
              details
            </Link>
          }
        >
          <Row label="Health">
            <span className="flex items-center gap-2">
              <StatusDot tone={healthTone} />
              <span className="font-mono">{health.status}</span>
              <span className="text-dim">
                {health.checks.filter((c) => c.status === "pass").length}/
                {health.checks.length} checks passing
              </span>
            </span>
          </Row>
          <Row label="Workspace">{ws.name}</Row>
          <Row label="Domain" mono>
            {ws.domain}
          </Row>
          <Row label="Model key">
            {key.state === "stored" ? (
              <span className="flex items-center gap-2">
                <Badge tone="ok">stored</Badge>
                <span className="font-mono text-dim">{key.masked}</span>
              </span>
            ) : key.state === "undecryptable" ? (
              <Badge tone="bad">undecryptable</Badge>
            ) : (
              <span className="flex items-center gap-2">
                <Badge tone="warn">not set</Badge>
                <Link href="/settings" className="text-accent hover:underline">
                  add one
                </Link>
              </span>
            )}
          </Row>
        </Panel>

        <Panel title="Build progress" hint="10 phases">
          <ol className="space-y-0.5">
            {PHASES.map((p) => (
              <li key={p.n} className="flex items-center gap-2 py-0.5">
                <StatusDot
                  tone={
                    p.state === "done" ? "ok" : p.state === "next" ? "warn" : "idle"
                  }
                />
                <span className="font-mono text-[11px] text-dim w-6">
                  {String(p.n).padStart(2, "0")}
                </span>
                <span
                  className={`text-[12px] ${
                    p.state === "todo" ? "text-dim" : "text-fg"
                  }`}
                >
                  {p.name}
                </span>
                {p.state === "next" && (
                  <span className="text-[10px] text-warn font-mono ml-auto">
                    next
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <Panel title="Not yet built" hint="listed so the gaps are visible, not hidden">
        <ul className="text-[12px] text-dim space-y-1">
          <li>
            Memory browser, review queue, coverage gaps and the metrics dashboard
            are unimplemented. They appear in the nav as their phases land.
          </li>
          <li>
            No model call has been made and no metric has been observed. Every
            number on this page is a count of rows in the database.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
