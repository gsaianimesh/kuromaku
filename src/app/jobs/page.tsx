import Link from "next/link";
import { Badge, Empty, Panel, type StatusTone } from "@/components/ui";
import { listHandlers } from "@/lib/jobs/handlers";
import { countByStatus, listJobs } from "@/lib/jobs/queue";
import type { JobStatus } from "@/lib/db/schema";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { EnqueueForm, RunWorkerButton } from "./job-controls";

export const dynamic = "force-dynamic";

export const STATUS_TONE: Record<JobStatus, StatusTone> = {
  queued: "idle",
  running: "warn",
  done: "ok",
  failed: "bad",
};

function relative(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default async function JobsPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const [jobs, counts] = await Promise.all([
    listJobs(ws.id, 50),
    countByStatus(ws.id),
  ]);

  const order: JobStatus[] = ["queued", "running", "done", "failed"];

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-medium">Jobs</h1>
        <div className="flex items-center gap-1.5">
          {order.map((s) => (
            <Badge key={s} tone={counts[s] ? STATUS_TONE[s] : "idle"}>
              {s} {counts[s] ?? 0}
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Enqueue" hint="type: noop">
          <EnqueueForm />
        </Panel>
        <Panel title="Worker">
          <RunWorkerButton />
          <div className="mt-3 pt-3 border-t border-edge/60">
            <p className="text-[11px] text-dim mb-1.5">Registered handlers</p>
            <ul className="space-y-1">
              {listHandlers().map((h) => (
                <li key={h.type} className="text-[11px]">
                  <span className="font-mono text-accent">{h.type}</span>
                  <span className="text-dim"> — {h.description}</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <Panel title="Queue" hint={`${jobs.length} most recent`}>
        {jobs.length === 0 ? (
          <Empty>No jobs yet. Enqueue one above.</Empty>
        ) : (
          <div className="overflow-x-auto -mx-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[11px] text-dim border-b border-edge">
                  <th className="text-left font-normal px-3 py-1.5">Status</th>
                  <th className="text-left font-normal px-3 py-1.5">Type</th>
                  <th className="text-left font-normal px-3 py-1.5">
                    Idempotency key
                  </th>
                  <th className="text-right font-normal px-3 py-1.5">Attempts</th>
                  <th className="text-left font-normal px-3 py-1.5">Created</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr
                    key={j.id}
                    className="border-b border-edge/50 last:border-0 hover:bg-raised/40"
                  >
                    <td className="px-3 py-1.5">
                      <Badge tone={STATUS_TONE[j.status]}>{j.status}</Badge>
                    </td>
                    <td className="px-3 py-1.5 font-mono">{j.type}</td>
                    <td className="px-3 py-1.5 font-mono text-muted max-w-[220px] truncate">
                      {j.idempotencyKey}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="px-3 py-1.5 text-dim whitespace-nowrap">
                      {relative(j.createdAt)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Link
                        href={`/jobs/${j.id}`}
                        className="text-accent hover:underline text-[11px]"
                      >
                        inspect
                      </Link>
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
