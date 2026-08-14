import Link from "next/link";
import { Badge, Panel, Row, StatusDot, type StatusTone } from "@/components/ui";
import { runHealthChecks } from "@/lib/health";
import { memoryStats } from "@/lib/memory";
import { listCoverageGaps } from "@/lib/planner";
import { observationSummary } from "@/lib/publish";
import { listArtifacts } from "@/lib/review";
import { getKeyStatus } from "@/lib/settings";
import { sourceStats } from "@/lib/sources";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Build status is derived from what actually exists in the repo, updated as
 * each phase lands. Nothing here is a measured metric — the metrics dashboard
 * arrives in Phase 5 and will show empty states until observations exist.
 */
const PHASES: Array<{ n: number; name: string; state: "done" | "next" | "todo" }> = [
  { n: 0, name: "Scaffold, BYOK, health", state: "done" },
  { n: 1, name: "Schema and job queue", state: "done" },
  { n: 2, name: "Ingestion", state: "done" },
  { n: 3, name: "Strategy compiler", state: "done" },
  { n: 4, name: "Memory viewer, staleness", state: "done" },
  { n: 5, name: "Community agent, critic, review queue", state: "done" },
  { n: 6, name: "Planner and coverage gaps", state: "done" },
  { n: 7, name: "Publishing and performance", state: "done" },
  { n: 8, name: "Content agent, REST, MCP", state: "done" },
  { n: 9, name: "Demo and docs", state: "done" },
];

export default async function Home() {
  const ws = await getOrCreateDefaultWorkspace();
  const [health, key, mem, srcStats, gaps, artifactRows, obs] = await Promise.all([
    runHealthChecks(),
    getKeyStatus(ws.id),
    memoryStats(ws.id),
    sourceStats(ws.id),
    listCoverageGaps(ws.id),
    listArtifacts(ws.id),
    observationSummary(ws.id),
  ]);

  const openGaps = gaps.filter((g) => g.status === "open").length;
  const artifactCount = artifactRows.length;
  const obsTotal = obs.total;

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
            ) : key.state === "env" ? (
              <span className="flex items-center gap-2 flex-wrap">
                <Badge tone="warn">env fallback</Badge>
                <span className="text-dim font-mono">{key.variable}</span>
                <span className="text-dim">development only</span>
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

      <Panel
        title="Workspace state"
        hint="counts of rows, not projections — nothing here is estimated"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Link href="/sources" className="block group">
            <p className="text-[11px] text-dim uppercase tracking-wide">Sources</p>
            <p className="text-[18px] font-mono group-hover:text-accent">
              {srcStats.count}
            </p>
          </Link>
          <Link href="/memory" className="block group">
            <p className="text-[11px] text-dim uppercase tracking-wide">
              Memory records
            </p>
            <p className="text-[18px] font-mono group-hover:text-accent">
              {mem.total}
            </p>
            {mem.unsourced > 0 ? (
              <p className="text-[11px] text-bad">{mem.unsourced} unsourced</p>
            ) : (
              <p className="text-[11px] text-dim">
                {mem.sourced} sourced, {mem.derived} derived
              </p>
            )}
          </Link>
          <Link href="/review" className="block group">
            <p className="text-[11px] text-dim uppercase tracking-wide">Artifacts</p>
            <p className="text-[18px] font-mono group-hover:text-accent">
              {artifactCount}
            </p>
          </Link>
          <Link href="/planner" className="block group">
            <p className="text-[11px] text-dim uppercase tracking-wide">
              Coverage gaps
            </p>
            <p
              className={`text-[18px] font-mono group-hover:text-accent ${openGaps > 0 ? "text-bad" : ""}`}
            >
              {openGaps}
            </p>
          </Link>
        </div>

        {obsTotal === 0 && (
          <p className="text-[11px] text-dim mt-3 pt-3 border-t border-edge/60">
            No performance has been observed yet, so the metrics dashboard is
            deliberately blank rather than showing zeros. A zero would claim
            something was measured and found to be nothing.
          </p>
        )}
      </Panel>
    </div>
  );
}
