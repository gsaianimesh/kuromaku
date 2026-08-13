import Link from "next/link";
import { Badge, Empty, Panel, Row } from "@/components/ui";
import { activeCrawl, lastCrawl, listSources, sourceStats } from "@/lib/sources";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { CrawlControls } from "./crawl-controls";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [rows, stats, active, last] = await Promise.all([
    listSources(ws.id),
    sourceStats(ws.id),
    activeCrawl(ws.id),
    lastCrawl(ws.id),
  ]);

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Sources</h1>
        <div className="flex items-center gap-1.5">
          <Badge tone={stats.count > 0 ? "ok" : "idle"}>
            {stats.count} page{stats.count === 1 ? "" : "s"}
          </Badge>
          {stats.count > 0 && (
            <Badge>{stats.totalChars.toLocaleString()} chars</Badge>
          )}
          {active && <Badge tone="warn">crawl {active.status}</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Crawl" hint="sitemap first · robots respected">
          <CrawlControls domain={ws.domain} />
        </Panel>

        <Panel title="Last crawl">
          {!last ? (
            <Empty>No crawl has run yet.</Empty>
          ) : (
            <>
              <Row label="Status">
                <Badge
                  tone={
                    last.status === "done"
                      ? "ok"
                      : last.status === "failed"
                        ? "bad"
                        : "warn"
                  }
                >
                  {last.status}
                </Badge>
              </Row>
              <Row label="Started" mono>
                {last.createdAt.toISOString()}
              </Row>
              <Row label="Attempts" mono>
                {last.attempts}/{last.maxAttempts}
              </Row>
              <Row label="Job" mono>
                <Link
                  href={`/jobs/${last.id}`}
                  className="text-accent hover:underline"
                >
                  {last.id.slice(0, 8)}
                </Link>
              </Row>
              {last.error && (
                <Row label="Error">
                  <span className="text-bad break-words">{last.error}</span>
                </Row>
              )}
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="Stored pages"
        hint="deduplicated by content hash — a re-crawl of unchanged pages adds nothing"
      >
        {rows.length === 0 ? (
          <Empty>
            No sources yet. Queue a crawl above, then run it.
          </Empty>
        ) : (
          <div className="overflow-x-auto -mx-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[11px] text-dim border-b border-edge">
                  <th className="text-left font-normal px-3 py-1.5">Title</th>
                  <th className="text-left font-normal px-3 py-1.5">URL</th>
                  <th className="text-right font-normal px-3 py-1.5">Chars</th>
                  <th className="text-left font-normal px-3 py-1.5">Hash</th>
                  <th className="text-left font-normal px-3 py-1.5">Fetched</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-edge/50 last:border-0 hover:bg-raised/40 align-top"
                  >
                    <td className="px-3 py-1.5 max-w-[260px]">
                      <Link
                        href={`/sources/${s.id}`}
                        className="text-accent hover:underline block truncate"
                      >
                        {s.title ?? "(untitled)"}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-dim max-w-[240px] truncate">
                      {s.url.replace(/^https?:\/\//, "")}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted">
                      {(s.rawText?.length ?? 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-dim">
                      {s.contentHash.slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5 text-dim whitespace-nowrap">
                      {s.fetchedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
