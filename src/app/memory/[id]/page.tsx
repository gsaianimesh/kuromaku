import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Empty, Panel, Row } from "@/components/ui";
import { getRecord, recordHistory, MEMORY_TYPE_LABELS } from "@/lib/memory";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function RecordHistoryPage({
  params,
}: PageProps<"/memory/[id]">) {
  const { id } = await params;
  const record = await getRecord(id);
  if (!record) notFound();

  const ws = await getOrCreateDefaultWorkspace();
  const history = await recordHistory(ws.id, record.type, record.key, record.locale);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Link href="/memory" className="text-[11px] text-accent hover:underline">
          ← memory
        </Link>
        <h1 className="text-[15px] font-medium font-mono">{record.key}</h1>
        <Badge>{MEMORY_TYPE_LABELS[record.type]}</Badge>
        <Badge>{record.locale}</Badge>
      </div>

      <Panel
        title="Version history"
        hint="append only — editing supersedes, it never overwrites"
      >
        {history.length === 0 ? (
          <Empty>No history.</Empty>
        ) : (
          <ol className="space-y-3">
            {history.map((v) => (
              <li
                key={v.id}
                className={`border rounded p-2.5 ${
                  v.status === "active"
                    ? "border-ok/30 bg-ok/5"
                    : "border-edge bg-input"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <Badge tone={v.status === "active" ? "ok" : "idle"}>
                    v{v.version} · {v.status}
                  </Badge>
                  <Badge tone={v.origin === "human" ? "warn" : "idle"}>
                    {v.origin}
                  </Badge>
                  <Badge>confidence {v.confidence.toFixed(2)}</Badge>
                  {v.unsourced && <Badge tone="bad">unsourced</Badge>}
                  <span className="text-[11px] text-dim font-mono ml-auto">
                    {v.createdAt.toISOString()}
                  </span>
                </div>
                <pre className="text-[11px] font-mono text-muted whitespace-pre-wrap break-words">
                  {JSON.stringify(v.value, null, 2)}
                </pre>
                {v.sources.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {v.sources.map((s) => (
                      <li key={s.id} className="text-[11px] text-dim">
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
                          (s.snippet ?? "asserted by human")
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Record">
        <Row label="ID" mono>
          <span className="text-dim">{record.id}</span>
        </Row>
        <Row label="Type" mono>
          {record.type}
        </Row>
        <Row label="Supersedes" mono>
          {record.supersedesId ? (
            <Link
              href={`/memory/${record.supersedesId}`}
              className="text-accent hover:underline"
            >
              {record.supersedesId.slice(0, 8)}
            </Link>
          ) : (
            <span className="text-dim">— first version</span>
          )}
        </Row>
      </Panel>
    </div>
  );
}
