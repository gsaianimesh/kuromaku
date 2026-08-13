"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Only routes that exist are listed. Later phases add memory, review queue,
 * jobs, coverage gaps and metrics.
 */
const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/sources", label: "Sources" },
  { href: "/memory", label: "Memory" },
  { href: "/review", label: "Review" },
  { href: "/planner", label: "Planner" },
  { href: "/publish", label: "Publish" },
  { href: "/metrics", label: "Metrics" },
  { href: "/jobs", label: "Jobs" },
  { href: "/settings", label: "Settings" },
  { href: "/health", label: "Health" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active =
          l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={[
              "px-2.5 py-1 rounded text-[12px] transition-colors",
              active
                ? "bg-raised text-fg"
                : "text-muted hover:text-fg hover:bg-raised/60",
            ].join(" ")}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
