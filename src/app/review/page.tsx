import Link from "next/link";
import { Badge, Empty, Panel, type StatusTone } from "@/components/ui";
import { listArtifacts, reviewStats, type ArtifactView } from "@/lib/review";
import { agentById } from "@/lib/agents/registry";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { RegenerateButton, ReviewActions, RunWorkButton } from "./review-controls";

export const dynamic = "force-dynamic";

function criticTone(score: number | null): StatusTone {
  if (score === null) return "idle";
  if (score >= 0.8) return "ok";
  if (score >= 0.7) return "warn";
  return "bad";
}

function ArtifactCard({ artifact }: { artifact: ArtifactView }) {
  const agent = agentById(artifact.agentId);
  const notes = artifact.criticNotes as {
    violations?: Array<{ rule: string; problem: string; severity: string }>;
    revisedAutomatically?: boolean;
  } | null;

  return (
    <Panel
      title={`${artifact.kind} · ${artifact.channel}`}
      hint={`${agent?.displayName ?? artifact.agentId} · ${artifact.locale}`}
      actions={
        <div className="flex items-center gap-1.5">
          <Badge tone={criticTone(artifact.criticScore)}>
            critic {artifact.criticScore?.toFixed(2) ?? "—"}
          </Badge>
          <Badge
            tone={
              artifact.status === "stale"
                ? "warn"
                : artifact.status === "approved"
                  ? "ok"
                  : artifact.status === "rejected"
                    ? "bad"
                    : "idle"
            }
          >
            {artifact.status}
          </Badge>
        </div>
      }
    >
      {artifact.status === "stale" && (
        <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2.5 space-y-2">
          <p className="text-[12px] text-warn">
            Stale. {artifact.staleEvidence.length} memory record
            {artifact.staleEvidence.length === 1 ? "" : "s"} this draft was
            derived from{" "}
            {artifact.staleEvidence.length === 1 ? "has" : "have"} been
            superseded since it was written:
          </p>
          <ul className="text-[11px] text-warn/90 space-y-0.5">
            {artifact.staleEvidence.map((e) => (
              <li key={e.id} className="font-mono">
                · {e.recordType}: {e.recordKey}
              </li>
            ))}
          </ul>
          <RegenerateButton artifactId={artifact.id} />
        </div>
      )}

      <pre className="text-[12px] whitespace-pre-wrap break-words bg-input border border-edge rounded p-2.5 max-h-72 overflow-y-auto">
        {artifact.contentFinal ?? artifact.content}
      </pre>

      {artifact.contentFinal && (
        <p className="text-[11px] text-dim mt-1">
          Showing the edited version. The original draft is retained for the
          edit-distance metric.
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] text-dim uppercase tracking-wide mb-1">
            Evidence
          </p>
          {artifact.evidence.length === 0 ? (
            <p className="text-[11px] text-bad">
              No evidence. This should be impossible — every draft must carry the
              records it rests on.
            </p>
          ) : (
            <ul className="space-y-1">
              {artifact.evidence.map((e) => (
                <li key={e.id} className="text-[11px]">
                  {e.memoryRecordId ? (
                    <Link
                      href={`/memory/${e.memoryRecordId}`}
                      className="text-accent hover:underline"
                    >
                      {e.recordKey ?? e.memoryRecordId.slice(0, 8)}
                    </Link>
                  ) : e.sourceUrl ? (
                    <a
                      href={e.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline break-all"
                    >
                      {e.sourceUrl}
                    </a>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                  <span className="text-dim"> · {e.note}</span>
                  {e.recordStatus === "superseded" && (
                    <span className="text-warn"> (superseded)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-[11px] text-dim uppercase tracking-wide mb-1">
            Critic
          </p>
          {notes?.revisedAutomatically && (
            <p className="text-[11px] text-warn mb-1">
              Scored below threshold and was revised once automatically before
              reaching you.
            </p>
          )}
          {notes?.violations && notes.violations.length > 0 ? (
            <ul className="space-y-1">
              {notes.violations.map((v, i) => (
                <li key={i} className="text-[11px] text-muted">
                  <span className="text-warn">[{v.severity}]</span> {v.rule}:{" "}
                  {v.problem}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-dim">No violations recorded.</p>
          )}

          <p className="text-[11px] text-dim uppercase tracking-wide mt-2.5 mb-1">
            Performance
          </p>
          {artifact.observationCount === 0 ? (
            <p className="text-[11px] text-dim italic">
              No observations recorded. Nothing is shown here that was not
              measured.
            </p>
          ) : (
            <p className="text-[11px] text-muted">
              {artifact.observationCount} observation
              {artifact.observationCount === 1 ? "" : "s"} recorded.{" "}
              <Link href="/metrics" className="text-accent hover:underline">
                view
              </Link>
            </p>
          )}
        </div>
      </div>

      {(artifact.status === "draft" || artifact.status === "stale") && (
        <ReviewActions
          artifactId={artifact.id}
          content={artifact.contentFinal ?? artifact.content}
        />
      )}

      <p className="text-[11px] text-dim mt-2">
        job{" "}
        {artifact.jobId ? (
          <Link href={`/jobs/${artifact.jobId}`} className="text-accent hover:underline">
            {artifact.jobId.slice(0, 8)}
          </Link>
        ) : (
          "—"
        )}{" "}
        · created {artifact.createdAt.toISOString()}
      </p>
    </Panel>
  );
}

export default async function ReviewPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [pending, stats] = await Promise.all([
    listArtifacts(ws.id, ["draft", "stale"]),
    reviewStats(ws.id),
  ]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Review queue</h1>
        <div className="flex items-center gap-1.5 flex-wrap">
          {Object.entries(stats.byStatus).map(([s, n]) => (
            <Badge key={s} tone={s === "stale" ? "warn" : "idle"}>
              {s} {n}
            </Badge>
          ))}
        </div>
      </div>

      <Panel title="Run work">
        <RunWorkButton />
      </Panel>

      {pending.length === 0 ? (
        <Panel title="Nothing to review">
          <Empty>
            No drafts waiting. Run the planner to schedule agent work, then run
            the queue above.
          </Empty>
        </Panel>
      ) : (
        pending.map((a) => <ArtifactCard key={a.id} artifact={a} />)
      )}
    </div>
  );
}
