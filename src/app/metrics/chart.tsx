"use client";

import { useId, useMemo, useState } from "react";

/**
 * Average edit distance per agent over time (SPEC 7.7) — "that falling line is
 * the proof the system learns, so it needs to be a real chart".
 *
 * Categorical palette validated against the #101215 chart surface in dark mode:
 * all four slots sit inside the L 0.48–0.67 band, clear the chroma floor, hold
 * adjacent CVD ΔE 9.6 (deutan) and normal-vision ΔE 21.6, and exceed 3:1
 * contrast. Hues are assigned in fixed order by agent id and never cycled — a
 * filter that changes which agents appear must not repaint the survivors.
 */
const SERIES_COLORS = ["#5296e8", "#c9793c", "#a06fd0", "#2ba39c"] as const;

const SURFACE = "#101215";

export type Point = {
  day: string;
  agentId: string;
  avgDistance: number;
  reviews: number;
};

type Series = { agentId: string; color: string; points: Point[] };

const PAD = { top: 14, right: 84, bottom: 26, left: 34 };
const W = 640;
const H = 220;

export function EditDistanceChart({ series: raw }: { series: Point[] }) {
  const clipId = useId();
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { series, days, plotW, plotH } = useMemo(() => {
    const agentIds = [...new Set(raw.map((p) => p.agentId))].sort();
    const days = [...new Set(raw.map((p) => p.day))].sort();
    const series: Series[] = agentIds.map((agentId, i) => ({
      agentId,
      // Fixed order, never cycled: a 5th agent would fold into "other" rather
      // than reuse slot 1's hue.
      color: SERIES_COLORS[i] ?? "var(--fg-dim)",
      points: raw.filter((p) => p.agentId === agentId),
    }));
    return {
      series,
      days,
      plotW: W - PAD.left - PAD.right,
      plotH: H - PAD.top - PAD.bottom,
    };
  }, [raw]);

  // A single day cannot show a trend, so the x scale centres it rather than
  // dividing by zero.
  const x = (day: string) =>
    days.length <= 1
      ? PAD.left + plotW / 2
      : PAD.left + (days.indexOf(day) / (days.length - 1)) * plotW;

  // Edit distance is already normalised 0–1, so the axis is the full range —
  // no auto-zoom that would exaggerate a small change.
  const y = (v: number) => PAD.top + (1 - v) * plotH;

  const hovered = hoverDay
    ? raw.filter((p) => p.day === hoverDay)
    : [];

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[420px] h-auto"
          role="img"
          aria-label={`Average edit distance per agent across ${days.length} day${days.length === 1 ? "" : "s"}. A falling line means humans are changing drafts less.`}
          onMouseLeave={() => setHoverDay(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {/* Recessive grid. Four lines is enough to read a 0–1 range. */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(v) + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--fg-dim)"
                fontFamily="var(--font-mono)"
              >
                {v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* Crosshair */}
          {hoverDay && (
            <line
              x1={x(hoverDay)}
              x2={x(hoverDay)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--border-strong)"
              strokeWidth={1}
            />
          )}

          <g clipPath={`url(#${clipId})`}>
            {series.map((s) => {
              const path = s.points
                .slice()
                .sort((a, b) => a.day.localeCompare(b.day))
                .map(
                  (p, i) =>
                    `${i === 0 ? "M" : "L"} ${x(p.day).toFixed(1)} ${y(p.avgDistance).toFixed(1)}`,
                )
                .join(" ");
              return (
                <path
                  key={s.agentId}
                  d={path}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}
          </g>

          {/* Markers, with a 2px surface ring so overlapping points stay legible */}
          {series.map((s) =>
            s.points.map((p) => (
              <circle
                key={`${s.agentId}-${p.day}`}
                cx={x(p.day)}
                cy={y(p.avgDistance)}
                r={hoverDay === p.day ? 5 : 4}
                fill={s.color}
                stroke={SURFACE}
                strokeWidth={2}
              />
            )),
          )}

          {/* Direct labels — identity is never carried by color alone */}
          {series.map((s) => {
            const last = s.points
              .slice()
              .sort((a, b) => a.day.localeCompare(b.day))
              .at(-1);
            if (!last) return null;
            return (
              <text
                key={`label-${s.agentId}`}
                x={x(last.day) + 8}
                y={y(last.avgDistance) + 3}
                fontSize={10}
                fill="var(--fg-muted)"
                fontFamily="var(--font-mono)"
              >
                {s.agentId}
              </text>
            );
          })}

          {/* X axis: first and last day only, to avoid label collision */}
          {days.length > 0 && (
            <>
              <text
                x={PAD.left}
                y={H - 8}
                fontSize={9}
                fill="var(--fg-dim)"
                fontFamily="var(--font-mono)"
              >
                {days[0]}
              </text>
              {days.length > 1 && (
                <text
                  x={PAD.left + plotW}
                  y={H - 8}
                  textAnchor="end"
                  fontSize={9}
                  fill="var(--fg-dim)"
                  fontFamily="var(--font-mono)"
                >
                  {days.at(-1)}
                </text>
              )}
            </>
          )}

          {/* Hit targets, wider than the marks */}
          {days.map((d) => (
            <rect
              key={`hit-${d}`}
              x={x(d) - Math.max(12, plotW / Math.max(days.length, 1) / 2)}
              y={PAD.top}
              width={Math.max(24, plotW / Math.max(days.length, 1))}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverDay(d)}
            />
          ))}
        </svg>
      </div>

      {/* Legend — always present for two or more series */}
      {series.length >= 2 && (
        <div className="flex items-center gap-3 flex-wrap">
          {series.map((s) => (
            <span key={s.agentId} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className="text-[11px] text-muted font-mono">{s.agentId}</span>
            </span>
          ))}
        </div>
      )}

      {hoverDay && hovered.length > 0 && (
        <div className="border border-edge-strong rounded bg-raised px-2.5 py-1.5 inline-block">
          <p className="text-[11px] font-mono text-dim">{hoverDay}</p>
          {hovered.map((p) => (
            <p key={p.agentId} className="text-[11px] flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{
                  background:
                    series.find((s) => s.agentId === p.agentId)?.color ?? "currentColor",
                }}
                aria-hidden
              />
              <span className="text-muted font-mono">{p.agentId}</span>
              <span className="text-fg font-mono">{p.avgDistance.toFixed(3)}</span>
              <span className="text-dim">
                ({p.reviews} review{p.reviews === 1 ? "" : "s"})
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="text-[11px] text-accent hover:underline"
        >
          {showTable ? "hide table" : "view as table"}
        </button>
        <span className="text-[11px] text-dim">
          0 means the human changed nothing; 1 means they replaced it entirely.
        </span>
      </div>

      {showTable && (
        <table className="w-full text-[11px] border border-edge rounded">
          <thead>
            <tr className="text-dim border-b border-edge">
              <th className="text-left font-normal px-2 py-1">Day</th>
              <th className="text-left font-normal px-2 py-1">Agent</th>
              <th className="text-right font-normal px-2 py-1">Avg distance</th>
              <th className="text-right font-normal px-2 py-1">Reviews</th>
            </tr>
          </thead>
          <tbody>
            {raw.map((p, i) => (
              <tr key={i} className="border-b border-edge/50 last:border-0">
                <td className="px-2 py-1 font-mono text-muted">{p.day}</td>
                <td className="px-2 py-1 font-mono">{p.agentId}</td>
                <td className="px-2 py-1 text-right font-mono">
                  {p.avgDistance.toFixed(3)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-muted">
                  {p.reviews}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
