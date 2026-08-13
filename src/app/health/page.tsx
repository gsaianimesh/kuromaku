import { Badge, Panel, StatusDot, type StatusTone } from "@/components/ui";
import { runHealthChecks, type CheckStatus } from "@/lib/health";

export const dynamic = "force-dynamic";

const TONE: Record<CheckStatus, StatusTone> = {
  pass: "ok",
  warn: "warn",
  fail: "bad",
};

export default async function HealthPage() {
  const report = await runHealthChecks();

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-medium">System health</h1>
        <Badge tone={TONE[report.status]}>{report.status.toUpperCase()}</Badge>
      </div>

      <Panel
        title="Checks"
        hint={`checked at ${new Date(report.checkedAt).toISOString()}`}
      >
        <ul className="divide-y divide-edge/60">
          {report.checks.map((c) => (
            <li key={c.id} className="py-2 flex items-start gap-2.5">
              <span className="mt-1.5">
                <StatusDot tone={TONE[c.status]} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px]">{c.label}</span>
                  {c.durationMs !== undefined && (
                    <span className="text-[11px] text-dim font-mono">
                      {c.durationMs}ms
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted font-mono break-words mt-0.5">
                  {c.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="text-[11px] text-dim">
        Machine-readable at{" "}
        <a href="/api/health" className="text-accent hover:underline font-mono">
          /api/health
        </a>
        . Returns 503 when any check fails.
      </p>
    </div>
  );
}
