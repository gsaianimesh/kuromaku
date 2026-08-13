"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import {
  markPostedAction,
  recordObservationAction,
  type PublishState,
} from "./actions";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      className="px-2.5 py-1 rounded bg-accent-dim border border-accent/40 text-[11px] hover:bg-accent/30"
    >
      {copied ? "copied" : "copy to clipboard"}
    </button>
  );
}

export function MarkPostedForm({ artifactId }: { artifactId: string }) {
  const [state, action] = useActionState<PublishState, FormData>(
    markPostedAction,
    null,
  );
  const router = useRouter();

  return (
    <form
      action={async (fd) => {
        await action(fd);
        router.refresh();
      }}
      className="flex items-center gap-2 flex-wrap mt-2"
    >
      <input type="hidden" name="artifactId" value={artifactId} />
      <input
        name="externalUrl"
        placeholder="https://… the URL where you posted it"
        className="bg-input border border-edge-strong rounded px-2 py-1 text-[11px] font-mono flex-1 min-w-[240px] focus:outline-none focus:border-accent"
      />
      <button
        type="submit"
        className="px-2.5 py-1 rounded bg-raised border border-edge-strong text-[11px] hover:border-accent"
      >
        I posted this
      </button>
      {state && (
        <span className={`text-[11px] ${state.ok ? "text-ok" : "text-bad"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}

export function ObservationForm({ artifactId }: { artifactId: string }) {
  const [state, action] = useActionState<PublishState, FormData>(
    recordObservationAction,
    null,
  );
  const router = useRouter();

  return (
    <form
      action={async (fd) => {
        await action(fd);
        router.refresh();
      }}
      className="flex items-center gap-2 flex-wrap mt-2"
    >
      <input type="hidden" name="artifactId" value={artifactId} />
      <input
        name="metric"
        list="known-metrics"
        placeholder="metric"
        className="bg-input border border-edge-strong rounded px-2 py-1 text-[11px] font-mono w-32 focus:outline-none focus:border-accent"
      />
      <datalist id="known-metrics">
        {["impressions", "clicks", "upvotes", "comments", "replies", "signups"].map(
          (m) => (
            <option key={m} value={m} />
          ),
        )}
      </datalist>
      <input
        name="value"
        type="number"
        step="any"
        placeholder="value"
        className="bg-input border border-edge-strong rounded px-2 py-1 text-[11px] font-mono w-24 focus:outline-none focus:border-accent"
      />
      <button
        type="submit"
        className="px-2.5 py-1 rounded bg-raised border border-edge-strong text-[11px] hover:border-accent"
      >
        Record observation
      </button>
      {state && (
        <span className={`text-[11px] ${state.ok ? "text-ok" : "text-bad"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
