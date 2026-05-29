"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Train page run/lift switch. Both sections are server-rendered and present in
 * the DOM; this only toggles which one is visible (one tap, no navigation).
 */
export function SportToggle({
  run,
  lift,
}: {
  run: React.ReactNode;
  lift: React.ReactNode;
}) {
  const [sport, setSport] = React.useState<"run" | "lift">("run");

  return (
    <div className="space-y-8">
      <div className="inline-flex rounded-xl border border-[color:var(--color-border-default)] bg-card/70 p-1 text-sm">
        {(["run", "lift"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSport(s)}
            aria-pressed={sport === s}
            className={cn(
              "rounded-lg px-4 py-1.5 font-medium transition-colors",
              sport === s
                ? "bg-[color:var(--ui-accent-soft)] text-[color:var(--color-text-primary)]"
                : "text-stone-500 hover:text-stone-700",
            )}
          >
            {s === "run" ? "Running" : "Lifting"}
          </button>
        ))}
      </div>
      <div className={sport === "run" ? "" : "hidden"}>{run}</div>
      <div className={sport === "lift" ? "" : "hidden"}>{lift}</div>
    </div>
  );
}
