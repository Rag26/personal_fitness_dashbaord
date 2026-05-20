"use client";

import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import {
  formatPaceMinPerMile,
  metersToFeet,
  metersToMiles,
  paceSecondsPerMile,
  secondsToHhMmSs,
} from "@/lib/units";
import { formatZonedDateShortWithYear } from "@/lib/format-zoned";
import { HEARTRATE_ZONE_BAR_COLORS, type RunTag, getTagDefinition } from "@/lib/run-tag";
import type { EffortLevel } from "@/lib/run-metrics";
import { EXERTION_LEVEL_COLORS } from "@/lib/run-metrics";

const RunRouteMap = dynamic(() => import("./run-route-map"), {
  ssr: false,
  loading: () => (
    <div className="h-[320px] w-full animate-pulse rounded-2xl border border-[color:var(--color-border-subtle)] bg-[color:var(--ui-accent-soft)]/40" />
  ),
});

export type RecentRunRow = {
  rowKey: string;
  source: "STRAVA";
  providerActivityId: string;
  tag: RunTag;
  exertion: { score10: number | null; level: string } | null;
  /** Bullet-point reasoning behind the classification at this run's point in time. */
  classificationReasons: string[];
  /** One-line summary of the thresholds in effect at the run's point in time. */
  classificationThresholds: string;
  /** Bullet-point reasoning behind the effort score / level. */
  exertionReasons: string[];
  /** One-line summary of the effort distribution in effect for this run's window. */
  exertionThresholds: string;
  name: string;
  startAtIso: string;
  distanceMeters: number | null;
  movingTimeSec: number | null;
  totalElevationM: number | null;
  averageHrBpm: number | null;
  maxHrBpm: number | null;
};

type ZoneBucket = {
  min: number;
  max: number;
  timeSec: number;
};

type ZoneBlock = {
  type: string;
  sensorBased: boolean;
  customZones: boolean;
  buckets: ZoneBucket[];
};

type DetailsResponse = {
  ok: boolean;
  polyline?: string | null;
  zones?: ZoneBlock[];
  zonesError?: string | null;
  zonesHint?: string | null;
  error?: string;
};

type DetailsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      polyline: string | null;
      zones: ZoneBlock[];
      zonesError: string | null;
      zonesHint: string | null;
    };

const HR_ZONE_LABELS = [
  "Z1 · Recovery",
  "Z2 · Endurance",
  "Z3 · Tempo",
  "Z4 · Threshold",
  "Z5 · VO₂ max",
];

function colorForZoneIndex(idx: number, total: number) {
  const palette = HEARTRATE_ZONE_BAR_COLORS;
  if (total <= palette.length) return palette[idx] ?? palette[palette.length - 1];
  return palette[idx % palette.length] ?? palette[palette.length - 1];
}

function zoneLabel(idx: number, total: number, bucket: ZoneBucket) {
  if (total === HEARTRATE_ZONE_BAR_COLORS.length) return HR_ZONE_LABELS[idx];
  if (bucket.max <= 0) return `Z${idx + 1} · ${bucket.min}+ bpm`;
  return `Z${idx + 1} · ${bucket.min}–${bucket.max} bpm`;
}

function fmtHms(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  return secondsToHhMmSs(seconds);
}

function RunTagBadge({ tag, size = "sm" }: { tag: RunTag; size?: "xs" | "sm" }) {
  const padding = size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold tracking-wide uppercase ${padding}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${tag.color} 22%, transparent)`,
        color: `color-mix(in srgb, ${tag.color} 65%, var(--foreground))`,
      }}
      title={tag.description}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: tag.color }}
      />
      {tag.label}
    </span>
  );
}

function ZoneBreakdown({ zones, hint }: { zones: ZoneBlock[]; hint?: string | null }) {
  const hr = zones.find((z) => z.type === "heartrate");
  if (!hr || hr.buckets.length === 0) {
    return (
      <p className="text-sm text-stone-500">
        Heart rate zone data is not available for this run.
      </p>
    );
  }
  const totalTime = hr.buckets.reduce((acc, b) => acc + Math.max(0, b.timeSec), 0);
  if (totalTime <= 0) {
    return (
      <p className="text-sm text-stone-500">
        Heart rate zone data is not available for this run.
      </p>
    );
  }

  const total = hr.buckets.length;
  const bucketsWithMeta = hr.buckets.map((b, i) => ({
    bucket: b,
    pct: totalTime > 0 ? (b.timeSec / totalTime) * 100 : 0,
    color: colorForZoneIndex(i, total),
    label: zoneLabel(i, total, b),
    index: i,
  }));

  const easySec = bucketsWithMeta.slice(0, Math.min(2, total)).reduce((a, x) => a + x.bucket.timeSec, 0);
  const aerobicSec = total >= 3 ? bucketsWithMeta[2].bucket.timeSec : 0;
  const hardSec = bucketsWithMeta.slice(3).reduce((a, x) => a + x.bucket.timeSec, 0);
  const blend = [
    { label: "Easy", subtitle: "Z1–Z2", sec: easySec, color: getTagDefinition("easy").color },
    { label: "Aerobic", subtitle: "Z3", sec: aerobicSec, color: getTagDefinition("tempo").color },
    { label: "Hard", subtitle: "Z4–Z5", sec: hardSec, color: getTagDefinition("intervals").color },
  ];

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold tracking-wider text-stone-600 uppercase">
            Heart rate zones
          </h4>
          {hint ? (
            <p className="mt-0.5 text-[10px] leading-snug text-stone-500">{hint}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-stone-500">Total {fmtHms(totalTime)}</span>
      </div>

      <div>
        <div className="flex h-3 w-full overflow-hidden rounded-full ring-1 ring-[color:var(--color-border-subtle)]">
          {bucketsWithMeta.map((z) => (
            <div
              key={`stack-${z.index}`}
              title={`${z.label} · ${fmtHms(z.bucket.timeSec)} (${z.pct.toFixed(0)}%)`}
              className="transition-[width] duration-500 ease-out"
              style={{ width: `${z.pct}%`, backgroundColor: z.color }}
            />
          ))}
        </div>
        <div className="mt-1.5 text-[10px] text-stone-500">Time-in-zone distribution</div>
      </div>

      <ul className="flex-1 space-y-3">
        {bucketsWithMeta.map((z) => (
          <li key={`row-${z.index}`}>
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="inline-flex items-center gap-2 font-medium text-stone-700">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: z.color }}
                />
                {z.label}
              </span>
              <span className="tabular-nums text-stone-600">
                {fmtHms(z.bucket.timeSec)}
                <span className="ml-2 text-stone-400">{z.pct.toFixed(0)}%</span>
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-[color:var(--ui-accent-soft)]">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.max(z.pct, z.bucket.timeSec > 0 ? 2 : 0)}%`,
                  backgroundColor: z.color,
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-3 gap-2 border-t border-[color:var(--color-border-subtle)] pt-3">
        {blend.map((b) => {
          const pct = totalTime > 0 ? (b.sec / totalTime) * 100 : 0;
          return (
            <div
              key={b.label}
              className="rounded-lg border border-[color:var(--color-border-subtle)] bg-[color:var(--ui-accent-soft)]/30 px-2.5 py-2 transition-colors hover:bg-[color:var(--ui-accent-soft)]/60"
            >
              <div className="flex items-center justify-between text-[10px] text-stone-500">
                <span className="font-semibold tracking-wider text-stone-600 uppercase">
                  {b.label}
                </span>
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: b.color }} />
              </div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-stone-800">
                {fmtHms(b.sec)}
              </div>
              <div className="text-[10px] text-stone-500">
                {b.subtitle} · {pct.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={`inline-block transition-transform duration-300 ease-out ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path
        d="M4 2 L8 6 L4 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparkBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[color:var(--color-border-subtle)]/70">
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(2, pct)}%`, backgroundColor: color }}
      />
    </div>
  );
}

function ReasoningBlock({
  title,
  badge,
  reasons,
  thresholds,
}: {
  title: string;
  badge: ReactNode;
  reasons: string[];
  thresholds: string;
}) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-surface)]/60 px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] font-semibold tracking-wider text-stone-500 uppercase">
          {title}
        </span>
        {badge}
      </div>
      <ul className="space-y-1 text-[11px] leading-snug text-stone-700">
        {reasons.map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <span
              aria-hidden
              className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-stone-400"
            />
            <span>{r}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 text-[9px] leading-snug text-stone-500">{thresholds}</div>
    </div>
  );
}

function ExpandedPanel({
  row,
  state,
}: {
  row: RecentRunRow;
  state: DetailsState;
}) {
  if (state.status === "loading") {
    return (
      <div className="vf-fade-in-up flex items-center justify-center py-8 text-sm text-stone-500">
        <span className="mr-2 inline-block h-2 w-2 animate-ping rounded-full bg-[color:var(--ui-accent)]" />
        Loading run details…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="vf-fade-in-up py-3 text-sm text-[color:var(--ui-danger)]">{state.message}</div>
    );
  }
  if (state.status !== "ready") return null;

  const hr = state.zones.find((z) => z.type === "heartrate");
  const hasZones =
    !!hr && hr.buckets.length > 0 && hr.buckets.some((b) => b.timeSec > 0);
  const hasRoute = !!state.polyline && state.polyline.length > 0;
  const hasClassReason = row.classificationReasons.length > 0;
  const hasEffortReason = row.exertionReasons.length > 0;

  if (!hasZones && !hasRoute && !hasClassReason && !hasEffortReason) {
    return (
      <div className="vf-fade-in-up py-4 text-sm text-stone-500">
        Run information not available.
      </div>
    );
  }

  const tag = row.tag;
  return (
    <div className="vf-fade-in-up space-y-3">
      {(hasClassReason || hasEffortReason) ? (
        <div className="grid gap-2 md:grid-cols-2">
          {hasClassReason ? (
            <ReasoningBlock
              title="Why this classification"
              badge={<RunTagBadge tag={tag} size="xs" />}
              reasons={row.classificationReasons}
              thresholds={row.classificationThresholds}
            />
          ) : null}
          {hasEffortReason ? (
            <ReasoningBlock
              title="Why this effort score"
              badge={<ExertionPill exertion={row.exertion} />}
              reasons={row.exertionReasons}
              thresholds={row.exertionThresholds}
            />
          ) : null}
        </div>
      ) : null}

      <div className="grid items-stretch gap-6 md:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          {hasZones ? (
            <ZoneBreakdown zones={state.zones} hint={state.zonesHint} />
          ) : (
            <p className="text-sm text-stone-500">
              {state.zonesError ?? "Heart rate zone data is not available for this run."}
            </p>
          )}
        </div>
        <div className="min-w-0">
          {hasRoute ? (
            <RunRouteMap polyline={state.polyline as string} />
          ) : (
            <p className="text-sm text-stone-500">
              Route information is not available for this run.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SourcePill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--ui-accent-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase text-[color:var(--color-text-secondary)]">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--ui-accent)]" />
      Strava
    </span>
  );
}

function ExertionPill({
  exertion,
}: {
  exertion: { score10: number | null; level: string } | null;
}) {
  if (!exertion || exertion.score10 == null) {
    const u = EXERTION_LEVEL_COLORS.Unclassified;
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
        style={{
          backgroundColor: `color-mix(in srgb, ${u} 18%, transparent)`,
          color: `color-mix(in srgb, ${u} 55%, var(--foreground))`,
        }}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: u }} />
        Effort —
      </span>
    );
  }
  const v = exertion.score10;
  const color =
    EXERTION_LEVEL_COLORS[exertion.level as EffortLevel] ?? EXERTION_LEVEL_COLORS.Unclassified;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)`,
        color: `color-mix(in srgb, ${color} 70%, var(--foreground))`,
      }}
      title={`Effort: ${exertion.level} · ${v.toFixed(1)}/10`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {exertion.level} {v.toFixed(1)}
    </span>
  );
}

export function RecentRunsTable({ runs, tz }: { runs: RecentRunRow[]; tz: string }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailsState>>({});

  // Runs are already tagged on the server to avoid hydration mismatches.
  const taggedRuns = useMemo(() => runs, [runs]);

  // Reference distance for the spark bar (longest in the visible list).
  const longestMeters = useMemo(
    () => Math.max(0, ...runs.map((r) => r.distanceMeters ?? 0)),
    [runs],
  );

  const loadDetails = useCallback(async (row: RecentRunRow) => {
    if (!row.providerActivityId) return;
    setDetails((prev) => ({ ...prev, [row.rowKey]: { status: "loading" } }));
    try {
      const res = await fetch(
        `/api/strava/activity/${encodeURIComponent(row.providerActivityId)}/details`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => null)) as DetailsResponse | null;
      if (!res.ok || !json || !json.ok) {
        throw new Error(json?.error ?? `Request failed (${res.status})`);
      }
      setDetails((prev) => ({
        ...prev,
        [row.rowKey]: {
          status: "ready",
          polyline: json.polyline ?? null,
          zones: json.zones ?? [],
          zonesError: json.zonesError ?? null,
          zonesHint: json.zonesHint ?? null,
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load run details.";
      setDetails((prev) => ({
        ...prev,
        [row.rowKey]: { status: "error", message: msg },
      }));
    }
  }, []);

  useEffect(() => {
    if (!expandedKey) return;
    const row = runs.find((r) => r.rowKey === expandedKey);
    if (!row) return;
    const current = details[expandedKey];
    if (!current || current.status === "idle") {
      void loadDetails(row);
    }
  }, [expandedKey, runs, details, loadDetails]);

  const handleToggle = (row: RecentRunRow) => {
    if (row.source !== "STRAVA" || !row.providerActivityId) return;
    setExpandedKey((prev) => (prev === row.rowKey ? null : row.rowKey));
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-y-1.5 text-sm">
        <thead>
          <tr className="text-[10px] tracking-wider text-stone-500 uppercase">
            <th className="px-3 pb-2 text-left font-medium">Date</th>
            <th className="px-3 pb-2 text-left font-medium">Run</th>
            <th className="px-3 pb-2 text-right font-medium">Distance</th>
            <th className="px-3 pb-2 text-right font-medium">Time</th>
            <th className="px-3 pb-2 text-right font-medium">Pace</th>
            <th className="px-3 pb-2 text-right font-medium">Elev</th>
            <th className="px-3 pb-2 text-right font-medium">Avg HR</th>
            <th className="px-3 pb-2 text-right font-medium">Max HR</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 ? (
            <tr>
              <td
                colSpan={8}
                className="rounded-xl border border-dashed border-[color:var(--color-border-subtle)] px-3 py-8 text-center text-stone-500"
              >
                No runs found yet. Click &ldquo;Sync now&rdquo; in Settings.
              </td>
            </tr>
          ) : (
            taggedRuns.map((r, i) => {
              const tag = r.tag;
              const meters = r.distanceMeters ?? 0;
              const sec = r.movingTimeSec ?? 0;
              const runPace = formatPaceMinPerMile(
                paceSecondsPerMile({ seconds: sec, meters }),
              );
              const elevFt = r.totalElevationM ? metersToFeet(r.totalElevationM) : null;
              const isExpandable = r.source === "STRAVA" && !!r.providerActivityId;
              const isOpen = expandedKey === r.rowKey;
              const startAt = new Date(r.startAtIso);
              const distancePct =
                longestMeters > 0 ? (meters / longestMeters) * 100 : 0;
              const baseTdBg = isOpen
                ? "bg-[color:var(--ui-accent-soft)]"
                : "bg-[color:var(--color-bg-surface)]/65";
              const rowClass = `vf-fade-in-up group transition-colors duration-200 ease-out [&>td]:transition-colors [&>td]:duration-200 ${
                isExpandable ? "cursor-pointer hover:[&>td]:bg-[color:var(--ui-accent-soft)]" : ""
              }`;
              return (
                <Fragment key={r.rowKey}>
                  <tr
                    onClick={() => handleToggle(r)}
                    className={rowClass}
                    style={{ animationDelay: `${Math.min(i * 18, 240)}ms` }}
                    aria-expanded={isExpandable ? isOpen : undefined}
                  >
                    <td
                      className={`${baseTdBg} rounded-l-xl px-3 py-3 align-middle whitespace-nowrap text-stone-500 shadow-[inset_1px_0_0_var(--color-border-subtle),inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      <div className="flex items-center gap-2">
                        {isExpandable ? (
                          <span className="text-stone-400 transition-colors group-hover:text-[color:var(--ui-accent)]">
                            <ChevronIcon open={isOpen} />
                          </span>
                        ) : (
                          <span className="inline-block w-3" />
                        )}
                        <span className="text-stone-700">
                          {formatZonedDateShortWithYear(startAt, tz)}
                        </span>
                      </div>
                    </td>
                    <td
                      className={`${baseTdBg} min-w-[260px] px-3 py-3 align-middle shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <RunTagBadge tag={tag} />
                          <SourcePill />
                          <ExertionPill exertion={r.exertion} />
                        </div>
                        <div className="truncate font-medium text-stone-900">{r.name}</div>
                      </div>
                    </td>
                    <td
                      className={`${baseTdBg} px-3 py-3 text-right align-middle whitespace-nowrap text-stone-700 shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-medium tabular-nums">
                          {meters > 0 ? `${metersToMiles(meters).toFixed(2)} mi` : "—"}
                        </span>
                        {meters > 0 && (
                          <div className="w-16">
                            <SparkBar pct={distancePct} color={tag.color} />
                          </div>
                        )}
                      </div>
                    </td>
                    <td
                      className={`${baseTdBg} px-3 py-3 text-right align-middle tabular-nums whitespace-nowrap text-stone-700 shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      {sec > 0 ? secondsToHhMmSs(sec) : "—"}
                    </td>
                    <td
                      className={`${baseTdBg} px-3 py-3 text-right align-middle tabular-nums whitespace-nowrap text-stone-700 shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      {runPace}
                    </td>
                    <td
                      className={`${baseTdBg} px-3 py-3 text-right align-middle tabular-nums whitespace-nowrap text-stone-700 shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      {elevFt != null ? `${Math.round(elevFt)} ft` : "—"}
                    </td>
                    <td
                      className={`${baseTdBg} px-3 py-3 text-right align-middle tabular-nums whitespace-nowrap text-stone-700 shadow-[inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      {r.averageHrBpm ?? "—"}
                    </td>
                    <td
                      className={`${baseTdBg} rounded-r-xl px-3 py-3 text-right align-middle tabular-nums whitespace-nowrap text-stone-700 shadow-[inset_-1px_0_0_var(--color-border-subtle),inset_0_1px_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)]`}
                    >
                      {r.maxHrBpm ?? "—"}
                    </td>
                  </tr>
                  {isOpen && isExpandable ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="vf-expand-in rounded-xl bg-[color:var(--color-bg-surface)]/85 px-5 py-5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ui-accent)_20%,transparent)] backdrop-blur-sm"
                      >
                        <ExpandedPanel
                          row={r}
                          state={details[r.rowKey] ?? { status: "loading" }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
