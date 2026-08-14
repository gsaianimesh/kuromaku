"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/ui";
import {
  enqueueNoopAction,
  runWorkerAction,
  type EnqueueState,
  type RunState,
} from "./actions";

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-3 py-1.5 rounded bg-accent-dim text-fg text-[12px] border border-accent/40 hover:bg-accent/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? busy : idle}
    </button>
  );
}

export function EnqueueForm() {
  const [state, action] = useActionState<EnqueueState, FormData>(
    enqueueNoopAction,
    null,
  );
  // Deliberately stable across renders: retyping the same key is how you
  // demonstrate that a duplicate enqueue creates one job, not two.
  const [key, setKey] = useState("demo-job-1");

  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-[140px_1fr] gap-3 items-center">
        <label htmlFor="idempotencyKey" className="text-[12px] text-dim">
          Idempotency key
        </label>
        <div className="flex items-center gap-2">
          <input
            id="idempotencyKey"
            name="idempotencyKey"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-56 focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => setKey(`demo-job-${Math.floor(Math.random() * 10000)}`)}
            className="text-[11px] text-accent hover:underline"
          >
            randomise
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[140px_1fr] gap-3 items-center">
        <label htmlFor="sleepMs" className="text-[12px] text-dim">
          Work duration
        </label>
        <div className="flex items-center gap-2">
          <input
            id="sleepMs"
            name="sleepMs"
            type="number"
            min={0}
            max={10000}
            defaultValue={250}
            className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-24 focus:outline-none focus:border-accent"
          />
          <span className="text-[11px] text-dim">ms</span>
        </div>
      </div>

      <div className="grid grid-cols-[140px_1fr] gap-3 items-center">
        <label htmlFor="shouldFail" className="text-[12px] text-dim">
          Fail on purpose
        </label>
        <label className="flex items-center gap-2 text-[11px] text-dim">
          <input
            id="shouldFail"
            name="shouldFail"
            type="checkbox"
            className="accent-[var(--accent)]"
          />
          throws, to exercise retry with backoff
        </label>
      </div>

      <div className="grid grid-cols-[140px_1fr] gap-3">
        <span />
        <Submit idle="Enqueue job" busy="Enqueueing…" />
      </div>

      {state && (
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <span />
          <div
            className={`text-[12px] rounded border px-2.5 py-2 ${
              !state.ok
                ? "border-bad/30 bg-bad/10 text-bad"
                : state.created
                  ? "border-ok/30 bg-ok/10 text-ok"
                  : "border-warn/30 bg-warn/10 text-warn"
            }`}
          >
            {state.message}
          </div>
        </div>
      )}
    </form>
  );
}

export function RunWorkerButton() {
  const [state, setState] = useState<RunState>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setState(await runWorkerAction());
              router.refresh();
            })
          }
          className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] hover:border-accent disabled:opacity-50 transition-colors"
        >
          {pending ? "Draining…" : "Run worker now"}
        </button>
        <span className="text-[11px] text-dim">
          Also runs on a schedule from GitHub Actions.
        </span>
      </div>

      {state && (
        <div className="border border-edge rounded bg-input p-2.5 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono">
            <span className="text-dim">{state.at}</span>
            <Badge tone={state.result.processed.length > 0 ? "ok" : "idle"}>
              {state.result.processed.length} processed
            </Badge>
            {state.result.recovered > 0 && (
              <Badge tone="warn">{state.result.recovered} recovered</Badge>
            )}
            {state.result.hitLimit && <Badge tone="warn">hit limit</Badge>}
          </div>

          {state.result.processed.length === 0 ? (
            <p className="text-[11px] text-dim italic">
              Queue was empty. Nothing to claim.
            </p>
          ) : (
            <ul className="space-y-1">
              {state.result.processed.map((p) => (
                <li key={p.jobId} className="text-[11px] font-mono">
                  <span className="flex items-center gap-2 flex-wrap">
                    <Badge
                      tone={
                        p.outcome === "done"
                          ? "ok"
                          : p.outcome === "retrying"
                            ? "warn"
                            : "bad"
                      }
                    >
                      {p.outcome}
                    </Badge>
                    <span className="text-muted">{p.type}</span>
                    <span className="text-dim">{p.jobId.slice(0, 8)}</span>
                    <span className="text-dim">{p.durationMs}ms</span>
                  </span>
                  {p.log.map((line, i) => (
                    <span key={i} className="block text-dim pl-2">
                      · {line}
                    </span>
                  ))}
                  {p.error && (
                    <span className="block text-bad pl-2 break-words">
                      ! {p.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
