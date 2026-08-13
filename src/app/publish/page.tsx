import { Badge, Empty, Panel } from "@/components/ui";
import {
  exportFilename,
  publishableArtifacts,
  publishTargetFor,
} from "@/lib/publish";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { CopyButton, MarkPostedForm, ObservationForm } from "./publish-controls";

export const dynamic = "force-dynamic";

export default async function PublishPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const rows = await publishableArtifacts(ws.id);

  const approved = rows.filter((a) => a.status === "approved");
  const published = rows.filter((a) => a.status === "published");

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Publish</h1>
        <div className="flex items-center gap-1.5">
          <Badge>{approved.length} ready</Badge>
          <Badge tone="ok">{published.length} published</Badge>
        </div>
      </div>

      <Panel title="How publishing works here">
        <p className="text-[12px] text-muted">
          No agent posts anywhere. Every artifact goes live because a person put
          it there and said so. For Hacker News and Reddit in particular,
          automated posting breaks their rules, so the only supported flow is
          copy to clipboard, post it yourself, and confirm the URL.
        </p>
      </Panel>

      {approved.length === 0 ? (
        <Panel title="Ready to publish">
          <Empty>
            Nothing approved yet. Approve a draft in the review queue first.
          </Empty>
        </Panel>
      ) : (
        approved.map((a) => {
          const target = publishTargetFor(a.channel);
          const body = a.contentFinal ?? a.content;
          return (
            <Panel
              key={a.id}
              title={`${a.kind} · ${a.channel}`}
              hint={target.method === "file_export" ? "file export" : "copy and confirm"}
              actions={<Badge>{a.locale}</Badge>}
            >
              <pre className="text-[12px] whitespace-pre-wrap break-words bg-input border border-edge rounded p-2.5 max-h-56 overflow-y-auto">
                {body}
              </pre>

              <p className="text-[11px] text-muted mt-2">{target.instructions}</p>

              <div className="flex items-center gap-2 flex-wrap mt-2">
                <CopyButton text={body} />
                {target.method === "file_export" && (
                  <a
                    href={`/api/artifacts/${a.id}/export`}
                    className="px-2.5 py-1 rounded bg-raised border border-edge-strong text-[11px] hover:border-accent"
                  >
                    download {exportFilename(a)}
                  </a>
                )}
                {target.composeUrl && (
                  <a
                    href={target.composeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-accent hover:underline"
                  >
                    open {a.channel} composer
                  </a>
                )}
              </div>

              <MarkPostedForm artifactId={a.id} />
            </Panel>
          );
        })
      )}

      <Panel title="Published" hint="record what actually happened">
        {published.length === 0 ? (
          <Empty>Nothing published yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {published.map((a) => (
              <li key={a.id} className="border-b border-edge/60 pb-3 last:border-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge tone="ok">{a.channel}</Badge>
                  <span className="text-[12px]">{a.kind}</span>
                  {a.externalUrl && (
                    <a
                      href={a.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-accent hover:underline break-all"
                    >
                      {a.externalUrl}
                    </a>
                  )}
                  <span className="text-[11px] text-dim ml-auto">
                    {a.publishedAt?.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                <ObservationForm artifactId={a.id} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
