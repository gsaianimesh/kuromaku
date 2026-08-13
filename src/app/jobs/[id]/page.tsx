import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Empty, Panel, Row } from "@/components/ui";
import { getJob } from "@/lib/jobs/queue";
import { getHandler } from "@/lib/jobs/handlers";
import { STATUS_TONE } from "../page";

export const dynamic = "force-dynamic";

/**
 * Job and run inspector (SPEC section 8). Model calls, prompts and cost appear
 * here from Phase 3, when there is something to inspect. Until then the panel
 * says so rather than rendering an empty table that looks like data.
 */
export default async function JobDetail({
  params,
}: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  const handler = getHandler(job.type);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Link href="/jobs" className="text-[11px] text-accent hover:underline">
          ← jobs
        </Link>
        <h1 className="text-[15px] font-medium font-mono">{job.type}</h1>
        <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
      </div>

      <Panel title="Job">
        <Row label="ID" mono>
          <span className="text-dim">{job.id}</span>
        </Row>
        <Row label="Idempotency key" mono>
          {job.idempotencyKey}
        </Row>
        <Row label="Attempts" mono>
          {job.attempts} of {job.maxAttempts}
        </Row>
        <Row label="Created" mono>
          {job.createdAt.toISOString()}
        </Row>
        <Row label="Runnable after" mono>
          {job.runAfter.toISOString()}
          {/* A queued job that has already been attempted is waiting out its
              retry backoff — no clock read needed to know that. */}
          {job.status === "queued" && job.attempts > 0 && (
            <span className="text-warn ml-2">held for retry backoff</span>
          )}
        </Row>
        <Row label="Locked at" mono>
          {job.lockedAt ? job.lockedAt.toISOString() : <span className="text-dim">—</span>}
        </Row>
        <Row label="Completed" mono>
          {job.completedAt ? (
            job.completedAt.toISOString()
          ) : (
            <span className="text-dim">—</span>
          )}
        </Row>
      </Panel>

      <Panel title="Why this was scheduled">
        {job.reason ? (
          <p className="text-[12px]">{job.reason}</p>
        ) : (
          <Empty>
            No reason recorded. Planner-scheduled jobs always carry one from
            Phase 6.
          </Empty>
        )}
      </Panel>

      <Panel
        title="Payload"
        hint={handler ? `validated against the ${job.type} schema` : undefined}
      >
        <pre className="text-[11px] font-mono text-muted overflow-x-auto whitespace-pre-wrap break-words">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
        {!handler && (
          <p className="text-[11px] text-bad mt-2">
            No handler is registered for type &quot;{job.type}&quot;. This job will
            fail when claimed.
          </p>
        )}
      </Panel>

      {job.error && (
        <Panel title="Error">
          <pre className="text-[11px] font-mono text-bad overflow-x-auto whitespace-pre-wrap break-words">
            {job.error}
          </pre>
          {job.status === "queued" && (
            <p className="text-[11px] text-warn mt-2">
              Retained from a previous attempt. This job is queued for retry.
            </p>
          )}
        </Panel>
      )}

      <Panel title="Model calls" hint="prompt, tokens, cost">
        <Empty>
          No model calls. This job type does not call a model — agent runs are
          recorded here from Phase 3 onward.
        </Empty>
      </Panel>
    </div>
  );
}
