"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
import {
  regenerateAction,
  reviewAction,
  runQueuedWorkAction,
  type ReviewState,
} from "./actions";

export function ReviewActions({
  artifactId,
  content,
}: {
  artifactId: string;
  content: string;
}) {
  const [state, action] = useActionState<ReviewState, FormData>(reviewAction, null);
  const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle");
  const router = useRouter();

  return (
    <form
      action={async (fd) => {
        await action(fd);
        router.refresh();
      }}
      className="mt-3 pt-3 border-t border-edge/60 space-y-2"
    >
      <input type="hidden" name="artifactId" value={artifactId} />

      {mode === "edit" && (
        <textarea
          name="editedContent"
          defaultValue={content}
          rows={10}
          className="w-full bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono focus:outline-none focus:border-accent"
        />
      )}

      {mode === "reject" && (
        <input
          name="reason"
          placeholder="Why is this being rejected? This is the signal the system learns from."
          className="w-full bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] focus:outline-none focus:border-accent"
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {mode === "idle" && (
          <>
            <button
              type="submit"
              name="decision"
              value="approve"
              className="px-3 py-1.5 rounded bg-ok/15 border border-ok/40 text-ok text-[12px] hover:bg-ok/25"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setMode("edit")}
              className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] hover:border-accent"
            >
              Edit and approve
            </button>
            <button
              type="button"
              onClick={() => setMode("reject")}
              className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] text-bad hover:border-bad"
            >
              Reject
            </button>
          </>
        )}

        {mode === "edit" && (
          <>
            <button
              type="submit"
              name="decision"
              value="edit"
              className="px-3 py-1.5 rounded bg-accent-dim border border-accent/40 text-[12px] hover:bg-accent/30"
            >
              Save edits and approve
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="text-[11px] text-dim hover:text-fg"
            >
              cancel
            </button>
            <span className="text-[11px] text-dim">
              The original is kept, so the edit distance stays computable.
            </span>
          </>
        )}

        {mode === "reject" && (
          <>
            <button
              type="submit"
              name="decision"
              value="reject"
              className="px-3 py-1.5 rounded bg-bad/15 border border-bad/40 text-bad text-[12px] hover:bg-bad/25"
            >
              Confirm rejection
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="text-[11px] text-dim hover:text-fg"
            >
              cancel
            </button>
          </>
        )}
      </div>

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
    </form>
  );
}

export function RegenerateButton({ artifactId }: { artifactId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await regenerateAction(artifactId);
            setMsg(r?.message ?? null);
            router.refresh();
          })
        }
        className="px-2.5 py-1 rounded bg-warn/15 border border-warn/40 text-warn text-[11px] hover:bg-warn/25 disabled:opacity-50"
      >
        {pending ? "Queueing…" : "Regenerate from current memory"}
      </button>
      {msg && <span className="text-[11px] text-muted">{msg}</span>}
    </div>
  );
}

export function RunWorkButton() {
  const [result, setResult] = useState<{ log: string[]; outcomes: string[] } | null>(
    null,
  );
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
              setResult(await runQueuedWorkAction());
              router.refresh();
            })
          }
          className="px-3 py-1.5 rounded bg-accent-dim border border-accent/40 text-[12px] hover:bg-accent/30 disabled:opacity-50"
        >
          {pending ? "Running…" : "Run queued work"}
        </button>
        <span className="text-[11px] text-dim">
          Drains agent and planner jobs so you can watch drafts appear.
        </span>
      </div>

      {result && (
        <div className="border border-edge rounded bg-input p-2.5 max-h-80 overflow-y-auto space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {result.outcomes.length === 0 ? (
              <span className="text-[11px] text-dim italic">
                Queue was empty. Nothing to run.
              </span>
            ) : (
              result.outcomes.map((o, i) => (
                <Badge key={i} tone={o.includes("done") ? "ok" : "bad"}>
                  {o.slice(0, 120)}
                </Badge>
              ))
            )}
          </div>
          {result.log.map((l, i) => (
            <div key={i} className="text-[11px] font-mono text-dim break-words">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
