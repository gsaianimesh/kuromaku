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
            {record.unsourced && <Badge tone="bad">unsourced</Badge>}
          </div>

          <pre className="text-[11px] font-mono text-muted whitespace-pre-wrap break-words mt-1.5">
            {JSON.stringify(record.value, null, 2)}
          </pre>

          <div className="mt-1.5">
            {record.unsourced ? (
              <p className="text-[11px] text-bad">
                No source. This record is not grounded in any crawled page or
                search result — treat it as an unverified inference.
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
          const unsourced = rows.filter((r) => r.unsourced).length;
          return (
            <Panel
              key={type}
              title={MEMORY_TYPE_LABELS[type]}
              hint={`${rows.length} record${rows.length === 1 ? "" : "s"}${
                unsourced > 0 ? ` · ${unsourced} unsourced` : ""
              }`}
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
