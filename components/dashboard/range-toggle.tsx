"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Progress page time-range switch. Both ranges are server-rendered and present
 * in the DOM; this only toggles which one is visible.
 */
export function RangeToggle({
  thirtyDay,
  allTime,
}: {
  thirtyDay: React.ReactNode;
  allTime: React.ReactNode;
}) {
  const [range, setRange] = React.useState<"30d" | "all">("30d");

  return (
    <div className="space-y-8">
      <div className="inline-flex rounded-xl border border-[color:var(--color-border-default)] bg-card/70 p-1 text-sm">
        {(
          [
            ["30d", "Last 30 days"],
            ["all", "All time"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setRange(key)}
            aria-pressed={range === key}
            className={cn(
              "rounded-lg px-4 py-1.5 font-medium transition-colors",
              range === key
                ? "bg-[color:var(--ui-accent-soft)] text-[color:var(--color-text-primary)]"
                : "text-stone-500 hover:text-stone-700",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={range === "30d" ? "" : "hidden"}>{thirtyDay}</div>
      <div className={range === "all" ? "" : "hidden"}>{allTime}</div>
    </div>
  );
}
