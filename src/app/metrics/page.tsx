import Link from "next/link";
import { Badge, Empty, Panel, Row } from "@/components/ui";
import { editDistanceSeries, reviewStats } from "@/lib/review";
import { listObservations, observationSummary } from "@/lib/publish";
import { memoryStats } from "@/lib/memory";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { EditDistanceChart } from "./chart";

export const dynamic = "force-dynamic";

export default async function MetricsPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [stats, series, obs, obsSummary, memory] = await Promise.all([
    reviewStats(ws.id),
    editDistanceSeries(ws.id),
    listObservations(ws.id, 50),
    observationSummary(ws.id),
    memoryStats(ws.id),
  ]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <h1 className="text-[15px] font-medium">Metrics</h1>

      <Panel
        title="Edit distance per agent over time"
        hint="the proof the system learns — a falling line means humans are changing less"
      >
        {series.length === 0 ? (
          <Empty>
            No edits recorded yet. This chart appears once drafts have been
            edited and approved — it is not drawn from projections, so there is
            nothing to show until then.
          </Empty>
        ) : (
          <EditDistanceChart series={series} />
        )}

        <div className="mt-3 pt-3 border-t border-edge/60">
          <Row label="Reviews recorded" mono>
            {stats.totalReviews}
          </Row>
          <Row label="Of which were edits" mono>
            {stats.editsWithDistance}
          </Row>
          <Row label="Average edit distance" mono>
            {stats.averageEditDistance === null ? (
              <span className="text-dim">
                — no edits yet, so there is no average to report
              </span>
            ) : (
              stats.averageEditDistance.toFixed(3)
            )}
          </Row>
          <Row label="Average critic score" mono>
            {stats.averageCriticScore === null ? (
              <span className="text-dim">— no drafts scored yet</span>
            ) : (
              stats.averageCriticScore.toFixed(3)
            )}
          </Row>
        </div>
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Panel title="Per agent">
          {stats.perAgent.length === 0 ? (
            <Empty>No reviews yet.</Empty>
          ) : (
            <ul className="space-y-1">
              {stats.perAgent.map((a) => (
                <li key={a.agentId} className="text-[12px] flex items-baseline gap-2">
                  <span className="font-mono text-accent">{a.agentId}</span>
                  <span className="text-dim">
                    {a.reviews} review{a.reviews === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto font-mono">
                    {a.avgDistance === null ? (
                      <span className="text-dim">no edits</span>
                    ) : (
                      a.avgDistance.toFixed(3)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Memory health">
          <Row label="Active records" mono>
            {memory.total}
          </Row>
          <Row label="Sourced" mono>
            <span className="text-ok">
              {memory.sourced} ({((memory.sourced / memory.total) * 100).toFixed(0)}%)
            </span>
          </Row>
          <Row label="Derived" mono>
            {memory.derived} ({((memory.derived / memory.total) * 100).toFixed(0)}%)
          </Row>
          <Row label="Unsourced">
            {memory.unsourced === 0 ? (
              <span className="text-ok">none</span>
            ) : (
              <span className="text-bad">
                {memory.unsourced} ({((memory.unsourced / memory.total) * 100).toFixed(0)}%)
              </span>
            )}
          </Row>
          <Row label="Average confidence" mono>
            {memory.averageConfidence?.toFixed(3) ?? "—"}
          </Row>
          <Row label="Locales" mono>
            {memory.locales.join(", ") || "—"}
          </Row>
        </Panel>
      </div>

      <Panel
        title="Observations"
        hint="recorded, never generated — nothing here was projected"
      >
        {obsSummary.total === 0 ? (
          <div className="space-y-1.5">
            <Empty>
              No performance has been observed yet.
            </Empty>
            <p className="text-[11px] text-dim">
              This is deliberately blank rather than showing zeros. A zero would
              claim something was measured and found to be nothing; an empty
              state says nothing was measured. Record an observation from the{" "}
              <Link href="/publish" className="text-accent hover:underline">
                publish
              </Link>{" "}
              screen once something is live.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {obsSummary.byMetric.map((m) => (
                <Badge key={m.metric} tone="ok">
                  {m.metric}: {m.total.toLocaleString()} across {m.observations}
                </Badge>
              ))}
            </div>
            <div className="overflow-x-auto -mx-3">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[11px] text-dim border-b border-edge">
                    <th className="text-left font-normal px-3 py-1.5">Metric</th>
                    <th className="text-right font-normal px-3 py-1.5">Value</th>
                    <th className="text-left font-normal px-3 py-1.5">Channel</th>
                    <th className="text-left font-normal px-3 py-1.5">Source</th>
                    <th className="text-left font-normal px-3 py-1.5">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {obs.map((o) => (
                    <tr key={o.id} className="border-b border-edge/50 last:border-0">
                      <td className="px-3 py-1.5 font-mono">{o.metric}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {Number(o.value).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-muted">{o.channel ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        <Badge>{o.source}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-dim whitespace-nowrap">
                        {o.observedAt.toISOString().slice(0, 16).replace("T", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
