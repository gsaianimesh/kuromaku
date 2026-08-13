"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
import {
  editRecordAction,
  runCompileNowAction,
  startCompileAction,
  type EditState,
} from "./actions";

export function CompileControls({ sourceCount }: { sourceCount: number }) {
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [run, setRun] = useState<{ log: string[]; outcome: string | null } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      {sourceCount === 0 && (
        <p className="text-[12px] text-warn">
          No sources yet. Crawl the domain first — the compiler will not invent a
          memory from nothing.
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={pending || sourceCount === 0}
          onClick={() =>
            startTransition(async () => {
              const r = await startCompileAction();
              setQueueMsg(r?.message ?? null);
              router.refresh();
            })
          }
          className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] hover:border-accent disabled:opacity-50 transition-colors"
        >
          Queue compile
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await runCompileNowAction();
              setRun(r);
              router.refresh();
            })
          }
          className="px-3 py-1.5 rounded bg-accent-dim border border-accent/40 text-[12px] hover:bg-accent/30 disabled:opacity-50 transition-colors"
        >
          {pending ? "Compiling…" : "Run compile now"}
        </button>
        <span className="text-[11px] text-dim">
          Re-compiling supersedes records rather than duplicating them.
        </span>
      </div>

      {queueMsg && <p className="text-[12px] text-muted">{queueMsg}</p>}

      {run && (
        <div className="border border-edge rounded bg-input p-2.5 max-h-80 overflow-y-auto">
          {run.outcome && (
            <div className="mb-1.5">
              <Badge tone={run.outcome === "done" ? "ok" : "bad"}>{run.outcome}</Badge>
            </div>
          )}
          {run.log.length === 0 ? (
            <p className="text-[11px] text-dim italic">
              No compile job ran. Queue one first.
            </p>
          ) : (
            <ol className="space-y-0.5">
              {run.log.map((line, i) => (
                <li
                  key={i}
                  className={`text-[11px] font-mono break-words ${
                    line.includes("unsourced") && !line.includes("0 unsourced")
                      ? "text-warn"
                      : line.startsWith("stage")
                        ? "text-muted"
                        : "text-dim"
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
  );
}

export function EditRecordForm({
  recordId,
  initialValue,
  initialConfidence,
}: {
  recordId: string;
  initialValue: string;
  initialConfidence: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<EditState, FormData>(editRecordAction, null);
  const router = useRouter();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-accent hover:underline"
      >
        edit
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        await action(fd);
        router.refresh();
      }}
      className="mt-2 space-y-2 border-t border-edge pt-2"
    >
      <input type="hidden" name="recordId" value={recordId} />
      <textarea
        name="value"
        defaultValue={initialValue}
        rows={6}
        spellCheck={false}
        className="w-full bg-input border border-edge-strong rounded px-2 py-1.5 text-[11px] font-mono focus:outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-dim">confidence</label>
        <input
          name="confidence"
          type="number"
          step="0.05"
          min="0"
          max="1"
          defaultValue={initialConfidence}
          className="bg-input border border-edge-strong rounded px-2 py-1 text-[11px] font-mono w-20 focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="px-2.5 py-1 rounded bg-accent-dim border border-accent/40 text-[11px] hover:bg-accent/30"
        >
          Save new version
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-dim hover:text-fg"
        >
          cancel
        </button>
        <span className="text-[11px] text-dim">
          Editing supersedes; it never overwrites.
        </span>
      </div>
      {state && (
        <div
          className={`text-[11px] rounded border px-2 py-1.5 ${
            state.ok
              ? state.staleCount
                ? "border-warn/30 bg-warn/10 text-warn"
                : "border-ok/30 bg-ok/10 text-ok"
              : "border-bad/30 bg-bad/10 text-bad"
          }`}
        >
          {state.message}
        </div>
      )}
    </form>
  );
}
