"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { saveModelKeyAction, type ActionState } from "./actions";
import { Badge } from "@/components/ui";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-3 py-1.5 rounded bg-accent-dim text-fg text-[12px] border border-accent/40 hover:bg-accent/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? "Encrypting…" : "Save key"}
    </button>
  );
}

export function KeyForm({ currentProvider }: { currentProvider: string }) {
  const [state, action] = useActionState<ActionState, FormData>(
    saveModelKeyAction,
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      action={(fd) => {
        action(fd);
        // Clear immediately so the plaintext key does not linger in the DOM.
        if (inputRef.current) inputRef.current.value = "";
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
        <label htmlFor="provider" className="text-[12px] text-dim">
          Provider
        </label>
        <select
          id="provider"
          name="provider"
          defaultValue={currentProvider}
          className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-48 focus:outline-none focus:border-accent"
        >
          <option value="groq">Groq</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>

      <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
        <label htmlFor="key" className="text-[12px] text-dim">
          API key
        </label>
        <input
          ref={inputRef}
          id="key"
          name="key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="gsk_…"
          className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-full max-w-md focus:outline-none focus:border-accent"
        />
      </div>

      <div className="grid grid-cols-[160px_1fr] gap-3">
        <span />
        <div className="flex items-center gap-3">
          <SaveButton />
          <span className="text-[11px] text-dim">
            Encrypted with AES-256-GCM before it touches the database.
          </span>
        </div>
      </div>

      {state && (
        <div className="grid grid-cols-[160px_1fr] gap-3">
          <span />
          <div
            className={`text-[12px] rounded border px-2.5 py-2 ${
              state.ok
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-bad/30 bg-bad/10 text-bad"
            }`}
          >
            <p>{state.message}</p>
            {state.verified && (
              <p className="mt-1.5 flex items-center gap-2 font-mono text-[11px]">
                <span className="text-muted">round trip:</span>
                <span>{state.verified.masked}</span>
                <Badge tone={state.verified.matchedInput ? "ok" : "bad"}>
                  {state.verified.matchedInput ? "matches input" : "mismatch"}
                </Badge>
              </p>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
