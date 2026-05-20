import "server-only";
import Link from "next/link";

import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { BarChartView } from "@/components/charts/bar-chart";
import { AreaChartView } from "@/components/charts/area-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { fetchStravaRunsInRange } from "@/lib/merged-runs";
import { utcCalendarWindowBoundsMs } from "@/lib/calendar-range";
import { chartPalette } from "@/lib/chart-palette";
import {
  kgToLb,
  metersToMiles,
  paceSecondsPerMile,
} from "@/lib/units";
import {
  formatZonedDateShort,
  formatZonedWeekdayMonthDayYear,
  zonedDayKeyFromDate,
} from "@/lib/format-zoned";
import {
  addCalendarDaysToZonedParts,
  canonicalZonedDayStart,
  localCalendarParts,
  nextZonedCalendarDayStartMs,
  prevZonedCalendarDayStartMs,
  startOfZonedCalendarDay,
  startOfZonedWeekMondayContaining,
} from "@/lib/zoned-calendar";
import { projectWeight, type WeightSample } from "@/lib/weight-projection";
import {
  ageYearsAt,
  buildPerDayWeightKg,
  mifflinStJeorBmrKcal,
  type BiologicalSex,
} from "@/lib/nutrition-burn";

const PROJECTION_WINDOW_DAYS = 60;
const PROJECTION_HORIZON_DAYS = 28;
/** Cap on `take:` for the unified manual-weight pull. 100 covers >1 entry/day for 60d. */
const RECENT_MANUAL_LIMIT = 100;
const MIN_TRUSTED_CONSUMED_KCAL = 900;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function InsightsBelowFold({
  userId,
  tz,
  whoopConnected,
  todayIso,
}: {
  userId: string;
  tz: string;
  whoopConnected: boolean;
  todayIso: string;
}) {
  const shortDate = (d: Date) => formatZonedDateShort(d, tz);
  /** Same canonical calendar day as the weight chart — avoids rare DST/raw-ms mismatches. */
  const weightDayLong = (d: Date) =>
    formatZonedWeekdayMonthDayYear(canonicalZonedDayStart(d, tz), tz);
  const now = new Date();
  const { startMs, endMs, daysInWindow } = utcCalendarWindowBoundsMs(30, now);
  const rangeStart = new Date(startMs);
  const rangeEnd = new Date(endMs);

  /**
   * Oldest calendar day in the rolling weight window: today minus (N−1) days,
   * computed in the user's timezone (not fixed 24h steps — DST-safe).
   */
  const projectionStart = (() => {
    const tp = localCalendarParts(now, tz);
    const oldest = addCalendarDaysToZonedParts(
      tp.y,
      tp.m,
      tp.d,
      -(PROJECTION_WINDOW_DAYS - 1),
      tz,
    );
    return startOfZonedCalendarDay(oldest.y, oldest.m, oldest.d, tz);
  })();

  /**
   * Single 60-day WHOOP pull replaces the previous (whoop30 + 60-day-weight)
   * pair, and a single manual-log pull (`take` capped) replaces the previous
   * (60-day window + most-recent-10) pair.
   */
  const [runs30, whoop60, manualLogs] = await Promise.all([
    fetchStravaRunsInRange(userId, rangeStart, rangeEnd),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: projectionStart } },
      select: {
        date: true,
        recoveryScore: true,
        strain: true,
        restingHeartRateBpm: true,
        hrvRmssdMs: true,
        sleepMinutes: true,
        sleepPerformancePct: true,
        sleepEfficiencyPct: true,
        weightKg: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma().manualWeightLog.findMany({
      where: { userId },
      select: { id: true, date: true, weightKg: true, notes: true },
      orderBy: { date: "desc" },
      take: RECENT_MANUAL_LIMIT,
    }),
  ]);

  // Nutrition + profile inputs for deficit-aware weight projection.
  const [nutritionRows, burnProfile] = await Promise.all([
    prisma().dailyNutritionLog.findMany({
      where: { userId, date: { gte: projectionStart } },
      select: {
        date: true,
        source: true,
        caloriesKcal: true,
        activeEnergyKcal: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma().user.findUnique({
      where: { id: userId },
      select: { heightCm: true, dateOfBirth: true, biologicalSex: true },
    }),
  ]);

  /** 30-day slices derived from the single 60-day WHOOP pull. */
  const whoop30 = whoop60.filter(
    (r) => r.date.getTime() >= startMs && r.date.getTime() <= endMs,
  );
  /** WHOOP weight samples for the 60-day projection window. */
  const whoopWeightWindow = whoop60.filter(
    (r) => r.weightKg != null && r.weightKg > 0,
  );
  /** Manual log views derived from the single descending pull. */
  const recentManualLogs = manualLogs.slice(0, 10);
  const manualWeightWindow = manualLogs
    .filter((r) => r.date.getTime() >= projectionStart.getTime())
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const runsInWindow = runs30.filter(
    (r) => r.startAt.getTime() >= startMs && r.startAt.getTime() <= endMs,
  );

  const runsThisMonth = runsInWindow.length;
  const totalMi30 = runsInWindow.reduce((a, r) => a + metersToMiles(r.distanceMeters ?? 0), 0);
  const runDays = new Set(runsInWindow.map((r) => isoDay(r.startAt)));
  const consistency = Math.min(
    100,
    Math.round((runDays.size / Math.max(1, daysInWindow)) * 100),
  );

  const volByUtcDay = new Map<string, number>();
  for (const r of runsInWindow) {
    const k = isoDay(r.startAt);
    volByUtcDay.set(k, (volByUtcDay.get(k) ?? 0) + (r.distanceMeters ?? 0));
  }
  let bestDayKey: string | null = null;
  let bestMeters = 0;
  for (const [k, m] of volByUtcDay) {
    if (m > bestMeters) {
      bestMeters = m;
      bestDayKey = k;
    }
  }
  const bestRun =
    bestDayKey != null && bestMeters > 0
      ? runsInWindow.find((r) => isoDay(r.startAt) === bestDayKey)
      : undefined;
  const bestDayLabel =
    bestRun != null && bestMeters > 0
      ? formatZonedWeekdayMonthDayYear(bestRun.startAt, tz)
      : "—";

  /**
   * Build a unified weight history keyed by the **user's** calendar day so
   * WHOOP and manual entries that fall on the same day in the user's timezone
   * collapse to a single sample. Manual takes precedence on shared days.
   */
  const weightByDay = new Map<string, WeightSample>();
  for (const w of whoopWeightWindow) {
    if (w.weightKg != null && w.weightKg > 0) {
      weightByDay.set(zonedDayKeyFromDate(w.date, tz), {
        date: w.date,
        kg: w.weightKg,
        source: "whoop",
      });
    }
  }
  for (const m of manualWeightWindow) {
    if (m.weightKg != null && m.weightKg > 0) {
      weightByDay.set(zonedDayKeyFromDate(m.date, tz), {
        date: m.date,
        kg: m.weightKg,
        source: "manual",
      });
    }
  }
  const mergedWeightHistory = [...weightByDay.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  // Build per-day deficit (kcal) keyed by the same dayStartMs we pass to projectWeight.
  const toDayStartMs = (d: Date) => canonicalZonedDayStart(d, tz).getTime();
  const weightHistoryForBurn = mergedWeightHistory.map((s) => ({
    date: s.date,
    weightKg: s.kg,
  }));
  const todayStartMs = toDayStartMs(now);
  const weightByDayMs = buildPerDayWeightKg({
    history: weightHistoryForBurn,
    startDayMs: toDayStartMs(projectionStart),
    endDayMs: todayStartMs,
    dayStartMs: (d) => toDayStartMs(d),
    advanceCalendarDayMs: (ms) => nextZonedCalendarDayStartMs(ms, tz),
  });

  const sex: BiologicalSex | null =
    burnProfile?.biologicalSex === "MALE" ||
    burnProfile?.biologicalSex === "FEMALE" ||
    burnProfile?.biologicalSex === "OTHER"
      ? (burnProfile.biologicalSex as BiologicalSex)
      : null;
  const heightCm = burnProfile?.heightCm ?? null;
  const dob = burnProfile?.dateOfBirth ?? null;
  const burnReady = heightCm != null && dob != null && sex != null && weightByDayMs.size > 0;

  // Merge MANUAL-over-BACKFILL for consumed calories per day, and read activeEnergy separately.
  const consumedByDay = new Map<number, number>();
  const activeByDay = new Map<number, number>();
  const bestSourceByDay = new Map<number, "BACKFILL" | "MANUAL">();
  for (const r of nutritionRows) {
    const dayMs = toDayStartMs(r.date);
    if (r.activeEnergyKcal != null && r.activeEnergyKcal > 0) {
      activeByDay.set(dayMs, r.activeEnergyKcal);
    }
    if (r.caloriesKcal == null || !Number.isFinite(r.caloriesKcal)) continue;
    const existingSrc = bestSourceByDay.get(dayMs);
    if (!existingSrc) {
      bestSourceByDay.set(dayMs, r.source);
      consumedByDay.set(dayMs, r.caloriesKcal);
    } else if (r.source === "MANUAL" && existingSrc !== "MANUAL") {
      bestSourceByDay.set(dayMs, r.source);
      consumedByDay.set(dayMs, r.caloriesKcal);
    }
  }

  const deficitByDayMs = new Map<number, number>();
  if (burnReady) {
    for (const [dayMs, consumed] of consumedByDay) {
      if (!(consumed > MIN_TRUSTED_CONSUMED_KCAL)) continue;
      const weight = weightByDayMs.get(dayMs) ?? null;
      const ageY = dob ? ageYearsAt(dob, new Date(dayMs)) : null;
      const bmr =
        weight != null && ageY != null
          ? mifflinStJeorBmrKcal({
              weightKg: weight,
              heightCm: heightCm!,
              ageYears: ageY,
              sex: sex!,
            })
          : null;
      const active = activeByDay.get(dayMs) ?? 0;
      if (bmr == null) continue;
      const totalBurn = bmr + active;
      deficitByDayMs.set(dayMs, consumed - totalBurn);
    }
  }

  const projection = projectWeight({
    history: mergedWeightHistory,
    horizonDays: PROJECTION_HORIZON_DAYS,
    fitWindowDays: PROJECTION_WINDOW_DAYS,
    formatDate: shortDate,
    now,
    toDayStartMs,
    advanceCalendarDayMs: (ms) => nextZonedCalendarDayStartMs(ms, tz),
    retreatCalendarDayMs: (ms) => prevZonedCalendarDayStartMs(ms, tz),
    energyBalanceKcalByDayMs: deficitByDayMs,
  });

  /**
   * "Today" line = start of the user's **calendar** day for `now` in their
   * timezone. (Do not use `futureStartDateMs` — that is the first *projected*
   * day, which is often *tomorrow* when the last weigh-in was today.)
   */
  const projectionTodayLineLabel =
    projection.todayZonedDayStartMs != null
      ? shortDate(new Date(projection.todayZonedDayStartMs))
      : null;

  // First-vs-last in 30d window for the existing "Weight Δ" stat card.
  const weight30Series = mergedWeightHistory.filter(
    (s) => s.date.getTime() >= startMs && s.date.getTime() <= endMs,
  );
  const weightFirst = weight30Series[0]?.kg ?? null;
  const weightLast = weight30Series[weight30Series.length - 1]?.kg ?? null;

  const sleepMinutesAll = whoop30
    .map((r) => r.sleepMinutes)
    .filter((m): m is number => m != null && m > 0);
  const avgSleepH =
    sleepMinutesAll.length > 0
      ? sleepMinutesAll.reduce((a, v) => a + v, 0) / sleepMinutesAll.length / 60
      : null;

  const recoveryRows = whoop30.filter((r) => r.recoveryScore != null);
  const avgRecovery =
    recoveryRows.length > 0
      ? Math.round(recoveryRows.reduce((a, r) => a + (r.recoveryScore ?? 0), 0) / recoveryRows.length)
      : null;
  const hrvRows = whoop30.filter((r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0);
  const avgHrv =
    hrvRows.length > 0
      ? hrvRows.reduce((a, r) => a + (r.hrvRmssdMs ?? 0), 0) / hrvRows.length
      : null;

  const sleepByDateMerged = new Map<string, number>();
  for (const w of whoop30) {
    if (w.sleepMinutes != null && w.sleepMinutes > 0) sleepByDateMerged.set(isoDay(w.date), w.sleepMinutes);
  }
  const sleepPace: { day: string; sleep: number | null; pace: number | null }[] = [];
  for (const run of runsInWindow) {
    const prevNight = new Date(run.startAt.getTime() - 24 * 60 * 60 * 1000);
    const prevKey = isoDay(prevNight);
    const prevSleepMin = sleepByDateMerged.get(prevKey);
    const spm = paceSecondsPerMile({
      seconds: run.movingTimeSec ?? 0,
      meters: run.distanceMeters ?? 0,
    });
    sleepPace.push({
      day: shortDate(run.startAt),
      sleep:
        prevSleepMin != null && prevSleepMin > 0
          ? Number((prevSleepMin / 60).toFixed(1))
          : null,
      pace: spm != null ? Number((spm / 60).toFixed(2)) : null,
    });
  }

  const weekBuckets = new Map<number, { mi: number; runs: number }>();
  for (const run of runsInWindow) {
    const mon = startOfZonedWeekMondayContaining(run.startAt, tz);
    const k = mon.getTime();
    const cur = weekBuckets.get(k) ?? { mi: 0, runs: 0 };
    cur.mi += metersToMiles(run.distanceMeters ?? 0);
    cur.runs += 1;
    weekBuckets.set(k, cur);
  }
  const weeklyData = [...weekBuckets.entries()].map(([wk, v]) => ({
    week: shortDate(new Date(wk)),
    mi: Number(v.mi.toFixed(1)),
    runs: v.runs,
  }));

  const rhrData = whoop30
    .filter((r) => r.restingHeartRateBpm != null && r.restingHeartRateBpm > 0)
    .map((r) => ({
      day: shortDate(r.date),
      rhr: r.restingHeartRateBpm as number,
    }));

  const recoveryData = whoop30
    .filter((r) => r.recoveryScore != null)
    .map((r) => ({
      day: shortDate(r.date),
      recovery: r.recoveryScore,
      strain: r.strain != null ? Number(r.strain.toFixed(1)) : null,
    }));

  const hrvData = whoop30
    .filter((r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0)
    .map((r) => ({
      day: shortDate(r.date),
      hrv: Number((r.hrvRmssdMs ?? 0).toFixed(0)),
    }));

  const projectionSlopeAbs = Math.abs(projection.slopePerWeekLb);
  const projectionDirection = projection.slopePerWeekLb < 0 ? "losing" : "gaining";
  const projectionDescription = projection.hasTrend
    ? `Linear fit over ${projection.fitPointCount} measurements (last ${PROJECTION_WINDOW_DAYS}d) → ${projectionDirection} ${projectionSlopeAbs.toFixed(2)} lb/wk · clipped to ±1.5 lb/wk · R² ${projection.rSquared.toFixed(2)}`
    : `Need at least 4 measurements in the last ${PROJECTION_WINDOW_DAYS} days to fit a trend.`;

  const sourceTotals = mergedWeightHistory.reduce(
    (acc, s) => {
      acc[s.source] += 1;
      return acc;
    },
    { whoop: 0, manual: 0 },
  );

  return (
    <>
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Runs" value={String(runsThisMonth)} hint={`Strava · ${daysInWindow}d window`} />
        <StatCard title="Total distance" value={`${totalMi30.toFixed(1)} mi`} hint={`Strava · ${daysInWindow}d window`} />
        <StatCard
          title="Consistency"
          value={`${consistency}%`}
          hint={`Run days / ${daysInWindow} calendar days (UTC)`}
        />
        <StatCard title="Best day" value={bestDayLabel} hint="Most run distance (single UTC day)" />
        <StatCard
          title="Weight Δ"
          value={
            weightFirst != null && weightLast != null
              ? `${kgToLb(weightLast - weightFirst) >= 0 ? "+" : ""}${kgToLb(weightLast - weightFirst).toFixed(1)} lb`
              : "—"
          }
          hint={`First vs last in window · ${sourceTotals.whoop} WHOOP / ${sourceTotals.manual} manual`}
        />
        <StatCard
          title="Sleep (avg)"
          value={avgSleepH != null ? `${avgSleepH.toFixed(1)} h` : "—"}
          hint="WHOOP · 30d"
        />
        <StatCard
          title="Recovery"
          value={avgRecovery != null ? `${avgRecovery}%` : "—"}
          hint="30-day avg (WHOOP)"
        />
        <StatCard
          title="HRV"
          value={avgHrv != null ? `${avgHrv.toFixed(0)} ms` : "—"}
          hint="30-day avg RMSSD (WHOOP)"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="WHOOP Recovery vs Strain" description="Daily recovery % and strain score">
          <MultiLineChartView
            data={recoveryData}
            xKey="day"
            lines={[
              { dataKey: "recovery", color: "#22c55e", name: "Recovery %", yAxisId: "left" },
              { dataKey: "strain", color: chartPalette.adobe, name: "Strain", yAxisId: "right" },
            ]}
            yDomain={[0, 100]}
            rightYDomain={[0, "dataMax"]}
            height={240}
          />
        </ChartCard>
        <ChartCard title="Heart Rate Variability" description="WHOOP HRV RMSSD (ms) — higher = better recovered">
          <AreaChartView
            data={hrvData}
            xKey="day"
            yKey="hrv"
            color="#22c55e"
            yUnit=" ms"
            gradientId="ins-hrv"
            height={240}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Sleep vs pace"
          description="Sleep night before (WHOOP) vs run pace (min/mi)"
        >
          <MultiLineChartView
            data={sleepPace}
            xKey="day"
            lines={[
              { dataKey: "sleep", color: chartPalette.un, name: "Sleep (h)", yAxisId: "left" },
              { dataKey: "pace", color: chartPalette.cal, name: "Pace (min/mi)", yAxisId: "right" },
            ]}
            yDomain={[0, "dataMax"]}
            rightYDomain={["dataMin", "dataMax"]}
            height={240}
          />
        </ChartCard>
        <ChartCard title="Resting heart rate" description="WHOOP · 30d">
          <AreaChartView
            data={rhrData}
            xKey="day"
            yKey="rhr"
            color={chartPalette.gia}
            yUnit=" bpm"
            gradientId="ins-rhr"
            height={240}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section>
        <ChartCard
          title="Weight projection · next 4 weeks"
          description={projectionDescription}
          actions={
            projection.hasTrend && projection.projectedEndLb != null ? (
              <div className="text-right">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  4-week projection
                </div>
                <div className="text-base font-semibold text-stone-900">
                  {projection.projectedEndLb.toFixed(1)} lb
                </div>
                <div className="text-xs text-stone-500">
                  {projection.slopePerWeekLb >= 0 ? "+" : ""}
                  {projection.slopePerWeekLb.toFixed(2)} lb / wk
                </div>
              </div>
            ) : null
          }
        >
          <MultiLineChartView
            data={projection.points}
            xKey="day"
            lines={[
              {
                dataKey: "actualLb",
                color: chartPalette.gia,
                name: "Weight (lb)",
                yAxisId: "left",
              },
              {
                dataKey: "trendLb",
                color: chartPalette.amazon,
                name: "Projection",
                yAxisId: "left",
                strokeDasharray: "5 4",
                showDots: false,
              },
            ]}
            yDomain={["dataMin", "dataMax"]}
            referenceLines={
              projectionTodayLineLabel
                ? [
                    {
                      x: projectionTodayLineLabel,
                      label: "today",
                      color: "color-mix(in srgb, var(--ui-accent) 35%, transparent)",
                    },
                  ]
                : undefined
            }
            height={260}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Log a weight</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed text-stone-600">
              {whoopConnected
                ? "WHOOP body measurements are pulled automatically when you sync. Add a manual entry here for any day WHOOP missed — manual readings take precedence on shared days."
                : "WHOOP is not connected, so manual entries are the only source of weight data. Log a measurement whenever you weigh in."}
            </p>
            <form
              action="/api/insights/weight"
              method="post"
              className="grid gap-3 sm:grid-cols-2"
            >
              <label className="block sm:col-span-2">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Date
                </div>
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={todayIso}
                  max={todayIso}
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Weight
                </div>
                <input
                  name="weight"
                  type="number"
                  step="0.1"
                  min="40"
                  max="900"
                  placeholder="e.g. 178.4"
                  required
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Unit
                </div>
                <select
                  name="unit"
                  defaultValue="lb"
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                >
                  <option value="lb">Pounds (lb)</option>
                  <option value="kg">Kilograms (kg)</option>
                </select>
              </label>
              <label className="block sm:col-span-2">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Notes (optional)
                </div>
                <input
                  name="notes"
                  type="text"
                  maxLength={280}
                  placeholder="e.g. morning, post-run, post-meal"
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>
              <div className="sm:col-span-2 flex items-center gap-3">
                <button className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
                  Save entry
                </button>
                {whoopConnected ? (
                  <span className="text-xs text-stone-500">
                    Tip: log on days you weighed in but didn’t wear WHOOP.
                  </span>
                ) : (
                  <Link
                    href="/settings"
                    className="text-xs font-medium text-orange-700 underline-offset-2 hover:underline"
                  >
                    Connect WHOOP for automatic syncing →
                  </Link>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent manual entries</CardTitle>
          </CardHeader>
          <CardContent>
            {recentManualLogs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[color:var(--color-border-subtle)] p-6 text-sm text-stone-500">
                No manual entries yet. Log one on the left and it will appear here.
              </div>
            ) : (
              <ul className="divide-y divide-[color:var(--color-border-subtle)]">
                {recentManualLogs.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-stone-900">
                        {kgToLb(row.weightKg).toFixed(1)} lb
                        <span className="ml-2 text-xs font-normal text-stone-500">
                          {weightDayLong(row.date)}
                        </span>
                      </div>
                      {row.notes ? (
                        <div className="mt-0.5 truncate text-xs text-stone-500">
                          {row.notes}
                        </div>
                      ) : null}
                    </div>
                    <form action="/api/insights/weight" method="post">
                      <input type="hidden" name="_action" value="delete" />
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        className="text-xs font-medium text-stone-500 hover:text-[color:var(--ui-danger)]"
                      >
                        Delete
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Showing latest 10 of {sourceTotals.manual + recentManualLogs.length === sourceTotals.manual ? sourceTotals.manual : "your"} entries.
              Manual entries take precedence over WHOOP for the same day.
            </p>
          </CardContent>
        </Card>
      </section>

      <section>
        <ChartCard title="Weekly run volume" description="Strava · miles per week (runs in window)">
          <BarChartView data={weeklyData} xKey="week" yKey="mi" color={chartPalette.amazon} yUnit=" mi" />
        </ChartCard>
      </section>
    </>
  );
}
