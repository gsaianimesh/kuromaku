"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
import { acknowledgeGapAction, runPlannerAction } from "./actions";

export function RunPlannerButton() {
  const [result, setResult] = useState<{
    log: string[];
    outcome: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setResult(await runPlannerAction());
              router.refresh();
            })
          }
          className="px-3 py-1.5 rounded bg-accent-dim border border-accent/40 text-[12px] hover:bg-accent/30 disabled:opacity-50"
        >
          {pending ? "Planning…" : "Run planner now"}
        </button>
        <span className="text-[11px] text-dim">
          Also runs on the 5-minute cron.
        </span>
      </div>

      {result && (
        <div className="border border-edge rounded bg-input p-2.5 max-h-64 overflow-y-auto">
          {result.outcome && (
            <div className="mb-1.5">
              <Badge tone={result.outcome === "done" ? "ok" : "bad"}>
                {result.outcome}
              </Badge>
            </div>
          )}
          {result.log.length === 0 ? (
            <p className="text-[11px] text-dim italic">
              Planner produced no output.
            </p>
          ) : (
            result.log.map((l, i) => (
              <div
                key={i}
                className={`text-[11px] font-mono break-words ${
                  l.startsWith("coverage gap")
                    ? "text-bad"
                    : l.startsWith("skip")
                      ? "text-warn"
                      : "text-dim"
                }`}
              >
                {l}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function AcknowledgeGap({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await acknowledgeGapAction(id);
          router.refresh();
        })
      }
      className="text-[11px] text-dim hover:text-fg underline ml-auto"
    >
      {pending ? "…" : "acknowledge"}
    </button>
  );
}
