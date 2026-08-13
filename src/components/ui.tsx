import type { ReactNode } from "react";

/** Shared primitives for the dense operator UI. Deliberately few and plain. */

export function Panel({
  title,
  hint,
  actions,
  children,
  className = "",
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`border border-edge rounded bg-panel overflow-hidden ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 px-3 h-9 border-b border-edge bg-raised/40">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="text-[12px] font-medium tracking-wide uppercase text-muted shrink-0">
              {title}
            </h2>
            {hint && <span className="text-[11px] text-dim truncate">{hint}</span>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export type StatusTone = "ok" | "warn" | "bad" | "idle";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  idle: "bg-dim",
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONE_CLASS[tone]}`}
      aria-hidden
    />
  );
}

export function Badge({
  tone = "idle",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  const color: Record<StatusTone, string> = {
    ok: "text-ok border-ok/30 bg-ok/10",
    warn: "text-warn border-warn/30 bg-warn/10",
    bad: "text-bad border-bad/30 bg-bad/10",
    idle: "text-muted border-edge-strong bg-raised",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${color[tone]}`}
    >
      {children}
    </span>
  );
}

/** Label / value row. The workhorse of every inspector surface in this app. */
export function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 py-1.5 border-b border-edge/60 last:border-0 items-baseline">
      <span className="text-[12px] text-dim">{label}</span>
      <span className={`text-[12px] min-w-0 ${mono ? "font-mono" : ""}`}>
        {children}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] text-dim italic py-2">{children}</p>
  );
}
