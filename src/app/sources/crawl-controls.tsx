"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/ui";
import { runCrawlNowAction, startCrawlAction, type CrawlState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-3 py-1.5 rounded bg-accent-dim text-fg text-[12px] border border-accent/40 hover:bg-accent/30 disabled:opacity-50 transition-colors"
    >
      {pending ? "Queueing…" : "Queue crawl"}
    </button>
  );
}

export function CrawlControls({ domain }: { domain: string }) {
  const [state, action] = useActionState<CrawlState, FormData>(
    startCrawlAction,
    null,
  );
  const [run, setRun] = useState<{
    log: string[];
    outcome: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <div className="grid grid-cols-[110px_1fr] gap-3 items-center">
          <label htmlFor="domain" className="text-[12px] text-dim">
            Domain
          </label>
          <input
            id="domain"
            name="domain"
            defaultValue={domain}
            spellCheck={false}
            className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-64 focus:outline-none focus:border-accent"
          />
        </div>
        <div className="grid grid-cols-[110px_1fr] gap-3 items-center">
          <label htmlFor="maxPages" className="text-[12px] text-dim">
            Page cap
          </label>
          <div className="flex items-center gap-2">
            <input
              id="maxPages"
              name="maxPages"
              type="number"
              min={1}
              max={200}
              defaultValue={30}
              className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-20 focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-dim">pages</span>
          </div>
        </div>
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <span />
          <Submit />
        </div>
      </form>

      {state && (
        <div
          className={`text-[12px] rounded border px-2.5 py-2 ${
            state.ok
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-bad/30 bg-bad/10 text-bad"
          }`}
        >
          {state.message}
        </div>
      )}

      <div className="pt-3 border-t border-edge/60 space-y-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await runCrawlNowAction();
                setRun({ log: r.log, outcome: r.outcome });
                router.refresh();
              })
            }
            className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] hover:border-accent disabled:opacity-50 transition-colors"
          >
            {pending ? "Crawling…" : "Run crawl now"}
          </button>
          <span className="text-[11px] text-dim">
            Drains the queue in the foreground so you can watch the log.
          </span>
        </div>

        {run && (
          <div className="border border-edge rounded bg-input p-2.5 max-h-72 overflow-y-auto">
            {run.outcome && (
              <div className="mb-1.5">
                <Badge
                  tone={
                    run.outcome === "done"
                      ? "ok"
                      : run.outcome.startsWith("retrying")
                        ? "warn"
                        : "bad"
                  }
                >
                  {run.outcome}
                </Badge>
              </div>
            )}
            {run.log.length === 0 ? (
              <p className="text-[11px] text-dim italic">
                No crawl job ran. Queue one above first.
              </p>
            ) : (
              <ol className="space-y-0.5">
                {run.log.map((line, i) => (
                  <li
                    key={i}
                    className={`text-[11px] font-mono break-words ${
                      line.startsWith("stored")
                        ? "text-ok"
                        : line.startsWith("skip")
                          ? "text-warn"
                          : line.startsWith("unchanged")
                            ? "text-dim"
                            : "text-muted"
                    }`}
                  >
                    {line}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
