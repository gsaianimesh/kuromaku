import Link from "next/link";
import { Badge, Empty, Panel } from "@/components/ui";
import { AGENTS, coveredChannels } from "@/lib/agents/registry";
import { listCoverageGaps, recentPlannedJobs } from "@/lib/planner";
import { listActiveMemory } from "@/lib/memory";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { AcknowledgeGap, RunPlannerButton } from "./planner-controls";

export const dynamic = "force-dynamic";

export default async function PlannerPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [gaps, planned, memory] = await Promise.all([
    listCoverageGaps(ws.id),
    recentPlannedJobs(ws.id),
    listActiveMemory(ws.id),
  ]);

  const priorities = memory
    .filter((r) => r.type === "channel_priority")
    .map((r) => {
      const v = r.value as { channel?: string; rank?: number; rationale?: string };
      return {
        key: r.key,
        channel: (v.channel ?? r.key).toLowerCase().replace(/\s+/g, "_"),
        rank: v.rank ?? null,
        rationale: v.rationale ?? "",
      };
    })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const covered = coveredChannels();
  const openGaps = gaps.filter((g) => g.status === "open");

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Planner</h1>
        <div className="flex items-center gap-1.5">
          <Badge tone={openGaps.length > 0 ? "bad" : "ok"}>
            {openGaps.length} open coverage gap{openGaps.length === 1 ? "" : "s"}
          </Badge>
          <Badge>{AGENTS.length} registered agents</Badge>
        </div>
      </div>

      <Panel title="Run planner">
        <RunPlannerButton />
      </Panel>

      <Panel
        title="Coverage gaps"
        hint="a prioritised channel with no agent — surfaced, not ignored"
      >
        {gaps.length === 0 ? (
          <Empty>
            No gaps recorded yet. Run the planner to compare the compiled channel
            priorities against the registered agents.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {gaps.map((g) => (
              <li
                key={g.id}
                className={`rounded border p-2.5 ${
                  g.status === "open"
                    ? "border-bad/40 bg-bad/10"
                    : "border-edge bg-input"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[12px]">{g.channel}</span>
                  {g.priorityRank !== null && (
                    <Badge tone="warn">rank {g.priorityRank}</Badge>
                  )}
                  <Badge tone={g.status === "open" ? "bad" : "idle"}>{g.status}</Badge>
                  {g.status === "open" && <AcknowledgeGap id={g.id} />}
                </div>
                <p className="text-[11px] text-muted mt-1">{g.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Channel priorities vs agent coverage"
        hint="strategy on the left, what can actually execute it on the right"
      >
        {priorities.length === 0 ? (
          <Empty>
            No channel priorities in memory. Compile the strategy first.
          </Empty>
        ) : (
          <div className="overflow-x-auto -mx-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[11px] text-dim border-b border-edge">
                  <th className="text-left font-normal px-3 py-1.5">Rank</th>
                  <th className="text-left font-normal px-3 py-1.5">Channel</th>
                  <th className="text-left font-normal px-3 py-1.5">Agent</th>
                  <th className="text-left font-normal px-3 py-1.5">Rationale</th>
                </tr>
              </thead>
              <tbody>
                {priorities.map((p) => {
                  const has = covered.has(p.channel);
                  return (
                    <tr
                      key={p.key}
                      className="border-b border-edge/50 last:border-0 align-top"
                    >
                      <td className="px-3 py-1.5 font-mono text-muted">
                        {p.rank ?? "—"}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{p.channel}</td>
                      <td className="px-3 py-1.5">
                        {has ? (
                          <Badge tone="ok">covered</Badge>
                        ) : (
                          <Badge tone="bad">no agent</Badge>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-dim max-w-[280px]">
                        {p.rationale}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Registered agents" hint="seeded in code, not the database">
        <ul className="space-y-1.5">
          {AGENTS.map((a) => (
            <li key={a.id} className="text-[12px]">
              <span className="font-mono text-accent">{a.id}</span>{" "}
              <span className="text-dim">
                — {a.channels.join(", ")} · ~${a.estimatedCostUsd.toFixed(2)}/run
              </span>
              <p className="text-[11px] text-dim">{a.description}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Scheduled work" hint="every job carries the reason it was scheduled">
        {planned.length === 0 ? (
          <Empty>No planner-scheduled jobs yet.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {planned.map((j) => (
              <li key={j.id} className="text-[12px] border-b border-edge/50 pb-1.5 last:border-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    tone={
                      j.status === "done"
                        ? "ok"
                        : j.status === "failed"
                          ? "bad"
                          : j.status === "running"
                            ? "warn"
                            : "idle"
                    }
                  >
                    {j.status}
                  </Badge>
                  <span className="font-mono text-[11px] text-muted">
                    {(j.payload as { channel?: string }).channel ?? "—"}
                  </span>
                  <Link
                    href={`/jobs/${j.id}`}
                    className="text-[11px] text-accent hover:underline ml-auto"
                  >
                    inspect
                  </Link>
                </div>
                <p className="text-[11px] text-dim mt-0.5">{j.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
