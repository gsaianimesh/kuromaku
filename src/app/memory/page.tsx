import Link from "next/link";
import { Badge, Empty, Panel, type StatusTone } from "@/components/ui";
import {
  listActiveMemory,
  memoryStats,
  MEMORY_TYPE_LABELS,
  MEMORY_TYPE_ORDER,
  type RecordWithSources,
} from "@/lib/memory";
import { sourceStats } from "@/lib/sources";
import { searchAvailability } from "@/lib/search";
import type { MemoryType } from "@/lib/db/schema";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { DEMO_MODE } from "@/lib/demo";
import { CompileControls, EditRecordForm } from "./memory-controls";

export const dynamic = "force-dynamic";

function confidenceTone(c: number): StatusTone {
  if (c >= 0.75) return "ok";
  if (c >= 0.5) return "warn";
  return "bad";
}

function RecordRow({ record }: { record: RecordWithSources }) {
  return (
    <li className="py-2.5 border-b border-edge/60 last:border-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[12px] text-fg">{record.key}</span>
            <Badge tone={confidenceTone(record.confidence)}>
              {record.confidence.toFixed(2)}
            </Badge>
            <Badge>{record.locale}</Badge>
            <Badge tone={record.origin === "human" ? "warn" : "idle"}>
              {record.origin}
            </Badge>
            {record.version > 1 && <Badge>v{record.version}</Badge>}
            {record.grounding === "derived" && <Badge tone="idle">derived</Badge>}
            {record.grounding === "ungrounded" && <Badge tone="bad">unsourced</Badge>}
          </div>

          <pre className="text-[11px] font-mono text-muted whitespace-pre-wrap break-words mt-1.5">
            {JSON.stringify(record.value, null, 2)}
          </pre>

          <div className="mt-1.5">
            {record.grounding === "ungrounded" ? (
              <p className="text-[11px] text-bad">
                No source. This record is not grounded in any crawled page,
                search result, or other record — treat it as an unverified
                inference.
              </p>
            ) : record.grounding === "derived" ? (
              /*
               * A derived record has no URL of its own because no page states
               * it; it was compiled from records that do. Naming those, as
               * links, is the provenance. Calling it "unsourced" said the
               * system could not account for it, which was never true.
               */
              <p className="text-[11px] text-dim">
                <span className="text-muted">compiled from:</span>{" "}
                {record.derivedFrom.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 && <span className="text-muted">, </span>}
                    <Link
                      href={`/memory/${p.id}`}
                      className="text-accent hover:underline"
                    >
                      {p.type}: {p.key}
                    </Link>
                    {p.status === "superseded" && (
                      <span className="text-warn"> (superseded)</span>
                    )}
                  </span>
                ))}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {record.sources.map((s) => (
                  <li key={s.id} className="text-[11px] text-dim">
                    <span className="text-muted">source:</span>{" "}
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline break-all"
                      >
                        {s.sourceTitle ?? s.url}
                      </a>
                    ) : (
                      <span>{s.snippet ?? "asserted by human"}</span>
                    )}
                    {s.snippet && s.url && (
                      <span className="block pl-4 italic text-dim/80">
                        &ldquo;{s.snippet.slice(0, 200)}&rdquo;
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/memory/${record.id}`}
            className="text-[11px] text-accent hover:underline"
          >
            history
          </Link>
        </div>
      </div>

      <EditRecordForm
        recordId={record.id}
        initialValue={JSON.stringify(record.value, null, 2)}
        initialConfidence={record.confidence}
      />
    </li>
  );
}

export default async function MemoryPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [records, stats, srcStats, search] = await Promise.all([
    listActiveMemory(ws.id),
    memoryStats(ws.id),
    sourceStats(ws.id),
    searchAvailability(ws.id),
  ]);

  const grouped = new Map<MemoryType, RecordWithSources[]>();
  for (const r of records) {
    const list = grouped.get(r.type) ?? [];
    list.push(r);
    grouped.set(r.type, list);
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Memory</h1>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge tone={stats.total > 0 ? "ok" : "idle"}>{stats.total} active</Badge>
          <Badge tone="ok">{stats.sourced} sourced</Badge>
          {stats.derived > 0 && <Badge>{stats.derived} derived</Badge>}
          {stats.unsourced > 0 && (
            <Badge tone="bad">{stats.unsourced} unsourced</Badge>
          )}
          {stats.averageConfidence !== null && (
            <Badge>avg confidence {stats.averageConfidence.toFixed(2)}</Badge>
          )}
          {stats.locales.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
        </div>
      </div>

      <Panel title="Compile" hint={`${srcStats.count} source(s) available`}>
        {DEMO_MODE && (
          <p className="text-[11px] text-warn mb-2.5 pb-2.5 border-b border-edge/60">
            This is the public demo instance. Compiling is disabled here because
            it spends the owner&rsquo;s model credits — everything else on this
            page, including editing a record and watching what goes stale, works
            normally. Clone the repository to run a compile.
          </p>
        )}
        <CompileControls sourceCount={srcStats.count} />
        {!search.configured && (
          <p className="text-[11px] text-warn mt-2.5 pt-2.5 border-t border-edge/60">
            Web research is unavailable: no {search.envVar} is set, so the{" "}
            {search.provider} provider cannot be called. The competitors stage
            will run without search results and will mark anything it cannot
            ground as unsourced rather than inventing competitors.
          </p>
        )}
      </Panel>

      {records.length === 0 ? (
        <Panel title="Records">
          <Empty>
            No memory records yet. Compile from the crawled sources above.
          </Empty>
        </Panel>
      ) : (
        MEMORY_TYPE_ORDER.filter((t) => grouped.has(t)).map((type) => {
          const rows = grouped.get(type)!;
          const derived = rows.filter((r) => r.grounding === "derived").length;
          const unsourced = rows.filter((r) => r.unsourced).length;
          return (
            <Panel
              key={type}
              title={MEMORY_TYPE_LABELS[type]}
              hint={`${rows.length} record${rows.length === 1 ? "" : "s"}${
                derived > 0 ? ` · ${derived} derived` : ""
              }${unsourced > 0 ? ` · ${unsourced} unsourced` : ""}`}
            >
              <ul>
                {rows.map((r) => (
                  <RecordRow key={r.id} record={r} />
                ))}
              </ul>
            </Panel>
          );
        })
      )}
    </div>
  );
}
