"use client";

import * as React from "react";
import { Sparkles, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { useUserTimezone } from "@/components/providers/user-timezone-provider";
import { formatZonedDateTimeMedium } from "@/lib/format-zoned";
import { cn } from "@/lib/utils";

type InsightSection = {
  emoji: string;
  title: string;
  body: string;
  priority: "high" | "medium" | "low";
};

type AiInsightsResult = {
  summary: string;
  sections: InsightSection[];
  generatedAt: string;
};

const PRIORITY_STYLES: Record<string, string> = {
  high:
    "border-[color:color-mix(in_srgb,var(--ui-accent-3)_45%,transparent)] bg-[color:var(--ui-accent-3-soft)]",
  medium:
    "border-[color:color-mix(in_srgb,var(--ui-accent-2)_45%,transparent)] bg-[color:var(--ui-accent-2-soft)]",
  low:
    "border-[color:var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-bg-elevated)_70%,transparent)]",
};

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-[color:var(--ui-accent-3)]",
  medium: "bg-[color:var(--ui-accent-2)]",
  low: "bg-[color:color-mix(in_srgb,var(--ui-accent)_55%,var(--color-text-tertiary))]",
};

function InsightCard({ section }: { section: InsightSection }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-colors",
        PRIORITY_STYLES[section.priority] ?? PRIORITY_STYLES.low,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg leading-none" aria-hidden>
          {section.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-stone-900">
              {section.title}
            </h3>
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                PRIORITY_DOT[section.priority] ?? PRIORITY_DOT.low,
              )}
              title={`${section.priority} priority`}
            />
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
            {section.body}
          </p>
        </div>
      </div>
    </div>
  );
}

export function AiInsights() {
  const timeZone = useUserTimezone();
  const [result, setResult] = React.useState<AiInsightsResult | null>(null);
  const [cacheLoading, setCacheLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setCacheLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/insights/coach");
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          throw new Error(
            (json as { error?: string })?.error ?? `Request failed (${res.status})`,
          );
        }
        const data = (await res.json()) as { result: AiInsightsResult | null };
        if (!cancelled) setResult(data.result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Something went wrong");
        }
      } finally {
        if (!cancelled) setCacheLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = React.useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/insights/generate", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(
          (json as { error?: string })?.error ?? `Request failed (${res.status})`,
        );
      }
      const data = (await res.json()) as AiInsightsResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setGenerating(false);
    }
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-[color:var(--color-border-subtle)] bg-card/80 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border-subtle)]/70 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[image:linear-gradient(135deg,var(--ui-accent)_0%,var(--ui-accent-2)_100%)] shadow-sm">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              AI Coach Insights
            </h2>
            <p className="text-[11px] text-[color:var(--color-text-tertiary)]">
              Powered by Claude — not medical advice
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={generate}
            disabled={generating || cacheLoading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--color-border-default)] bg-[color:color-mix(in_srgb,var(--background)_60%,transparent)] px-3 text-xs font-medium text-[color:var(--color-text-secondary)] transition-all hover:bg-[color:var(--ui-accent-soft)] hover:text-[color:var(--color-text-primary)] disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-3 w-3", generating && "animate-spin")}
            />
            {generating
              ? "Analyzing…"
              : result
                ? "Regenerate"
                : "Generate insights"}
          </button>
          {result && (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--color-text-tertiary)] transition-colors hover:bg-[color:var(--ui-accent-soft)] hover:text-[color:var(--color-text-secondary)]"
              aria-label={collapsed ? "Expand insights" : "Collapse insights"}
            >
              {collapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {cacheLoading && (
          <div className="flex flex-col gap-3 py-8">
            <div className="h-20 animate-pulse rounded-xl bg-[color:var(--ui-accent-soft)]/50" />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="h-28 animate-pulse rounded-xl bg-[color:var(--color-bg-elevated)]" />
              <div className="h-28 animate-pulse rounded-xl bg-[color:var(--color-bg-elevated)]" />
            </div>
          </div>
        )}

        {generating && !result && !cacheLoading && (
          <div className="flex flex-col items-center gap-3 py-10">
            <div className="relative h-10 w-10">
              <div className="absolute inset-0 animate-ping rounded-full bg-[color:var(--ui-accent-soft)]" />
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-[image:linear-gradient(135deg,var(--ui-accent)_0%,var(--ui-accent-2)_100%)]">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
            </div>
            <div className="space-y-1 text-center">
              <p className="text-sm font-medium text-[color:var(--color-text-secondary)]">
                Analyzing your data…
              </p>
              <p className="text-xs text-[color:var(--color-text-tertiary)]">
                Reviewing 30 days of activity, sleep, and recovery metrics
              </p>
            </div>
          </div>
        )}

        {error && !cacheLoading && (
          <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--ui-danger)_35%,transparent)] bg-[color:var(--ui-danger-soft)] p-4 text-sm text-[color:color-mix(in_srgb,var(--ui-danger)_72%,var(--color-text-primary))]">
            {error}
          </div>
        )}

        {!cacheLoading && !result && !generating && !error && (
          <div className="py-8 text-center">
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              Get AI-powered observations from your last 30 days when you’re
              ready — nothing is sent until you tap Generate.
            </p>
          </div>
        )}

        {result && !cacheLoading && (
          <div
            className={cn(
              "space-y-4 transition-opacity",
              collapsed && "hidden",
              generating && "pointer-events-none opacity-60",
            )}
          >
            {/* Summary */}
            <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--ui-accent)_28%,transparent)] bg-[image:linear-gradient(90deg,var(--ui-accent-soft),var(--ui-accent-2-soft),var(--ui-accent-3-soft))] p-4">
              <p className="text-sm font-medium leading-relaxed text-[color:var(--color-text-secondary)]">
                {result.summary}
              </p>
            </div>

            {/* Sections sorted by priority */}
            <div className="grid gap-3 md:grid-cols-2">
              {[...result.sections]
                .sort((a, b) => {
                  const order = { high: 0, medium: 1, low: 2 };
                  return (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
                })
                .map((s, i) => (
                  <InsightCard key={i} section={s} />
                ))}
            </div>

            {/* Footer */}
            {result.generatedAt && (
              <p className="text-[11px] text-[color:var(--color-text-tertiary)]">
                Generated{" "}
                {formatZonedDateTimeMedium(new Date(result.generatedAt), timeZone)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
