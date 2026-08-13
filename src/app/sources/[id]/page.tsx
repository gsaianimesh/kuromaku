import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Panel, Row } from "@/components/ui";
import { getSource } from "@/lib/sources";

export const dynamic = "force-dynamic";

export default async function SourceDetail({
  params,
}: PageProps<"/sources/[id]">) {
  const { id } = await params;
  const source = await getSource(id);
  if (!source) notFound();

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Link href="/sources" className="text-[11px] text-accent hover:underline">
          ← sources
        </Link>
        <h1 className="text-[15px] font-medium truncate">
          {source.title ?? "(untitled)"}
        </h1>
        <Badge>{source.kind}</Badge>
      </div>

      <Panel title="Provenance">
        <Row label="URL" mono>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline break-all"
          >
            {source.url}
          </a>
        </Row>
        <Row label="Fetched" mono>
          {source.fetchedAt.toISOString()}
        </Row>
        <Row label="Content hash" mono>
          <span className="text-dim break-all">{source.contentHash}</span>
        </Row>
        <Row label="Length" mono>
          {(source.rawText?.length ?? 0).toLocaleString()} characters
        </Row>
      </Panel>

      <Panel
        title="Extracted text"
        hint="what the strategy compiler reads — not the raw HTML"
      >
        <pre className="text-[11px] font-mono text-muted whitespace-pre-wrap break-words max-h-[32rem] overflow-y-auto">
          {source.rawText}
        </pre>
      </Panel>
    </div>
  );
}
