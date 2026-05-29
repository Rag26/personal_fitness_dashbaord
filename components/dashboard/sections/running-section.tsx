import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { ActivityMonthCalendar } from "@/components/dashboard/activity-month-calendar";
import { AreaChartView } from "@/components/charts/area-chart";
import { BarChartView } from "@/components/charts/bar-chart";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { RunningChat } from "@/components/dashboard/running-chat";
import { RecentRunsTable, type RecentRunRow } from "@/components/dashboard/recent-runs-table";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import type { NormalizedRun, RunTableRow } from "@/lib/merged-runs";
import {
  fetchNormalizedRunsInRange,
  fetchRecentRunTableRows,
  fetchRunStartsInRange,
  fetchRecentRunDistancesMiForProfile,
} from "@/lib/merged-runs";
import {
  activeZonedDaysOfMonth,
  localCalendarParts,
  parseCalendarYearMonth,
  zonedMonthRangeUtc,
} from "@/lib/zoned-calendar";
import { chartPalette } from "@/lib/chart-palette";
import {
  formatPaceMinPerMile,
  metersToMiles,
  paceSecondsPerMile,
} from "@/lib/units";
import { formatZonedDateShort } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import {
  classifyRunWithReason,
  getTagDefinition,
  MIN_SAMPLES_FOR_ROLLING_ADAPTIVE,
  type RunTagId,
} from "@/lib/run-tag";
import { explainRunExertion, EXERTION_LEVEL_COLORS } from "@/lib/run-metrics";
import {
  buildPerRunHistoricalContexts,
  RUN_LABEL_HISTORY_WINDOW,
} from "@/lib/run-history-snapshot";

export const dynamic = "force-dynamic";

function toDateInputValue(d: Date, timeZone: string) {
  const p = localCalendarParts(d, timeZone);
  const y = String(p.y).padStart(4, "0");
  const m = String(p.m).padStart(2, "0");
  const day = String(p.d).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function RunningSection({
  searchParams,
}: {
  searchParams?: Promise<{ y?: string; m?: string; shoe?: string; reason?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();
  const now = new Date();
  const start7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true, runningShoeStartDate: true },
  });
  const tz = normalizeUserTimezone(user?.timezone);
  const cal = parseCalendarYearMonth(sp, tz);
  const monthRange = zonedMonthRangeUtc(cal.year, cal.month1, tz);

  const [runs7, recentRuns]: [NormalizedRun[], RunTableRow[]] =
    await Promise.all([
      fetchNormalizedRunsInRange(userId, start7, now),
      fetchRecentRunTableRows(userId, 30),
    ]);
  const [runStartsMonth, recentDistancesMi] = await Promise.all([
    fetchRunStartsInRange(userId, monthRange.start, monthRange.end),
    fetchRecentRunDistancesMiForProfile(userId, 90),
  ]);

  // Pull run history so each row can be labeled from a rolling window of the
  // last RUN_LABEL_HISTORY_WINDOW runs ending at that activity (same idea for
  // the newest run = "today" in the keys). Past rows keep their prior label.
  const HISTORY_POOL_LIMIT = 5000;
  const historyDescAll = await fetchRecentRunTableRows(userId, HISTORY_POOL_LIMIT);
  const historyAsc = [...historyDescAll].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );

  const { byRowKey: contextByRowKey, latest: latestContext } =
    buildPerRunHistoricalContexts({
      historyAsc,
      rowKeysToLabel: historyDescAll.slice(0, 30).map((r) => r.rowKey),
    });

  const trainingProfile = latestContext.trainingProfile;
  const exertionProfile = latestContext.exertionProfile;
  const userReferenceMaxHr = latestContext.userReferenceMaxHr;


  const activeRunDays = activeZonedDaysOfMonth(runStartsMonth, tz, cal.year, cal.month1);

  const runCount = runs7.length;
  const totalMeters = runs7.reduce((acc, r) => acc + (r.distanceMeters ?? 0), 0);
  const totalSeconds = runs7.reduce((acc, r) => acc + (r.movingTimeSec ?? 0), 0);
  const longestMeters = runs7.reduce((acc, r) => Math.max(acc, r.distanceMeters ?? 0), 0);
  const avgPace = formatPaceMinPerMile(paceSecondsPerMile({ seconds: totalSeconds, meters: totalMeters }));

  // Pace trend: per-run pace over time (newest last for chart)
  const paceData = [...recentRuns]
    .reverse()
    .filter((r) => (r.distanceMeters ?? 0) > 0 && (r.movingTimeSec ?? 0) > 0)
    .map((r) => {
      const spm = paceSecondsPerMile({
        seconds: r.movingTimeSec ?? 0,
        meters: r.distanceMeters ?? 0,
      });
      return {
        date: formatZonedDateShort(r.startAt, tz),
        pace: spm != null ? Number((spm / 60).toFixed(2)) : null,
      };
    })
    .filter((r) => r.pace != null);

  // Distance per run
  const distPerRun = [...recentRuns]
    .reverse()
    .map((r) => ({
      date: formatZonedDateShort(r.startAt, tz),
      mi: Number(metersToMiles(r.distanceMeters ?? 0).toFixed(2)),
    }));

  // HR per run
  const hrData = [...recentRuns]
    .reverse()
    .filter((r) => r.averageHrBpm != null)
    .map((r) => ({
      date: formatZonedDateShort(r.startAt, tz),
      avg: r.averageHrBpm,
      max: r.maxHrBpm,
    }));

  const SHOE_LIMIT_MI = 450;
  const shoeStart = user?.runningShoeStartDate ?? null;
  const shoeMilesMi =
    shoeStart != null
      ? await prisma().stravaActivity
          .aggregate({
            where: {
              userId,
              startAt: { gte: shoeStart, lte: now },
              OR: [{ type: "Run" }, { sportType: "Run" }],
            },
            _sum: { distanceMeters: true },
          })
          .then((r: { _sum: { distanceMeters: number | null } }) =>
            metersToMiles(r._sum.distanceMeters ?? 0),
          )
      : null;
  const shoeRemainingMi =
    shoeMilesMi != null ? Math.max(0, SHOE_LIMIT_MI - shoeMilesMi) : null;
  const shoePct =
    shoeMilesMi != null
      ? Math.max(0, Math.min(100, (shoeMilesMi / SHOE_LIMIT_MI) * 100))
      : null;

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Runs" value={String(runCount)} hint="Last 7d" />
        <StatCard title="Distance" value={`${metersToMiles(totalMeters).toFixed(1)} mi`} hint="Last 7d" />
        <StatCard title="Avg pace" value={avgPace} hint="Last 7d" />
        <StatCard title="Longest run" value={`${metersToMiles(longestMeters).toFixed(1)} mi`} hint="Last 7d" />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Pace trend" description="Min/mi per run (lower is faster)" className="lg:col-span-2">
          <AreaChartView
            data={paceData}
            xKey="date"
            yKey="pace"
            color={chartPalette.cal}
            yUnit=" min/mi"
            gradientId="pace"
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
        <ActivityMonthCalendar
          basePath="/train"
          variant="/running"
          year={cal.year}
          month1={cal.month1}
          timeZone={tz}
          activeDays={activeRunDays}
          legendLabel="run"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Distance per run" description="Miles per run">
          <BarChartView data={distPerRun} xKey="date" yKey="mi" color={chartPalette.amazon} yUnit=" mi" />
        </ChartCard>
        <ChartCard title="Heart rate" description="Per run · runs with HR data">
          <MultiLineChartView
            data={hrData}
            xKey="date"
            lines={[
              { dataKey: "avg", color: chartPalette.adobe, name: "Avg HR" },
              { dataKey: "max", color: chartPalette.gia, name: "Max HR" },
            ]}
            yDomain={["dataMin", "dataMax"]}
            height={200}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="Shoe tracker"
          description="Strava run miles since new-shoes date · replace ~450 mi"
          contentClassName="pt-0"
        >
          <div className="space-y-4">
            <form action="/api/running/shoes" method="post" className="space-y-2">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                New shoes date
              </div>
              <input
                type="date"
                name="shoeStartDate"
                defaultValue={shoeStart ? toDateInputValue(shoeStart, tz) : ""}
                className="h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
              />
              <button
                type="submit"
                className="h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card/70 px-3 text-sm font-medium text-[color:var(--color-text-primary)] transition-colors hover:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] hover:bg-[color:var(--ui-accent-soft)]"
              >
                Save
              </button>
              {sp.shoe === "saved" ? (
                <div className="text-xs text-stone-500">Saved.</div>
              ) : sp.shoe === "cleared" ? (
                <div className="text-xs text-stone-500">Cleared.</div>
              ) : sp.shoe === "error" ? (
                <div className="text-xs text-rose-700">
                  Could not save date{sp.reason ? `: ${sp.reason}` : ""}.
                </div>
              ) : null}
            </form>

            <div className="rounded-xl border border-[color:var(--color-border-subtle)] bg-card/60 p-3">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Miles on shoe
              </div>
              <div className="mt-1 text-2xl font-semibold tracking-tight text-stone-900">
                {shoeMilesMi != null ? shoeMilesMi.toFixed(1) : "—"}
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-[color:color-mix(in_srgb,var(--ui-accent)_10%,transparent)]">
                <div
                  className="h-2 rounded-full bg-[image:linear-gradient(90deg,var(--ui-accent),var(--ui-accent-2),var(--ui-accent-3))]"
                  style={{ width: `${shoePct ?? 0}%` }}
                  aria-hidden="true"
                />
              </div>
              <div className="mt-2 text-[10px] text-stone-400">
                Remaining: {shoeRemainingMi != null ? shoeRemainingMi.toFixed(1) : "—"} mi · Benchmark {SHOE_LIMIT_MI} mi
              </div>
            </div>
          </div>
        </ChartCard>
      </section>

      <section>
        <ChartCard
          title="Recent runs"
          description="Last 30 runs, newest first. Click a run for HR zones and (for Strava runs) route."
          contentClassName="pt-0"
        >
          <details className="mb-3 rounded-2xl border border-[color:var(--color-border-subtle)] bg-card/60 px-4 py-3">
            <summary className="cursor-pointer select-none list-none">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
                    Keys
                  </span>
                  <span className="rounded-full bg-[color:var(--ui-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-stone-600">
                    {userReferenceMaxHr
                      ? `HR normalized to ${userReferenceMaxHr} bpm max`
                      : "Uses available metrics"}{" "}
                    {trainingProfile.longRunMiles
                      ? `· Long run ≥ ${trainingProfile.longRunMiles.toFixed(1)} mi`
                      : "· Long run adapts as you progress"}
                  </span>
                </div>
                <span className="text-[10px] text-stone-500">Show</span>
              </div>
            </summary>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
                    Classification key
                  </div>
                  <span className="text-[10px] text-stone-500">
                    From your last {RUN_LABEL_HISTORY_WINDOW} runs (older rows keep their label)
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      "easy",
                      "recovery",
                      "tempo",
                      "threshold",
                      "intervals",
                      "race",
                      "long",
                      "unclassified",
                    ] satisfies RunTagId[]
                  ).map((id) => {
                    const t = getTagDefinition(id);
                    const desc =
                      id === "long" && trainingProfile.longRunMiles
                        ? `Long-distance aerobic run (≥${trainingProfile.longRunMiles.toFixed(1)} mi).`
                        : id === "recovery" && trainingProfile.recoveryMaxHrPct
                          ? `Short, low-HR shakeout (≤${trainingProfile.recoveryMaxHrPct.toFixed(0)}% max HR).`
                          : id === "easy" && trainingProfile.tempoMinHrPct && trainingProfile.recoveryMaxHrPct
                            ? `Conversational aerobic effort (${Math.round(trainingProfile.recoveryMaxHrPct + 1)}–${Math.round(trainingProfile.tempoMinHrPct - 1)}% max HR).`
                            : id === "tempo" && trainingProfile.tempoMinHrPct && trainingProfile.thresholdMinHrPct
                              ? `Comfortably hard aerobic effort (≥${trainingProfile.tempoMinHrPct.toFixed(0)}%, <${trainingProfile.thresholdMinHrPct.toFixed(0)}% max HR).`
                              : id === "threshold" && trainingProfile.thresholdMinHrPct && trainingProfile.intervalsMinHrPct
                                ? `Sustained effort near threshold (≥${trainingProfile.thresholdMinHrPct.toFixed(0)}%, <${trainingProfile.intervalsMinHrPct.toFixed(0)}% max HR).`
                                : id === "intervals" && trainingProfile.intervalsMinHrPct
                                  ? `Short hard workout (≥${trainingProfile.intervalsMinHrPct.toFixed(0)}% max HR).`
                                  : id === "race" && trainingProfile.raceMinHrPct
                                    ? `All-out effort (≥${trainingProfile.raceMinHrPct.toFixed(0)}% max HR).`
                                    : t.description;
                    return (
                      <div
                        key={id}
                        className="rounded-xl border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-surface)]/60 px-3 py-2 backdrop-blur-sm transition-colors hover:bg-[color:var(--ui-accent-soft)]/50"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${t.color} 22%, transparent)`,
                              color: `color-mix(in srgb, ${t.color} 65%, var(--foreground))`,
                            }}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: t.color }}
                            />
                            {t.label}
                          </span>
                          <span className="text-[11px] text-stone-500">{desc}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
                    Effort key
                  </div>
                  <span className="text-[10px] text-stone-500">
                    0–10 from HR load, pace stress, and hills — weighted ~55% / 30% / 15% when all apply;
                    weights rebalance if HR, pace baseline, or elevation is missing.
                  </span>
                </div>

                <div className="grid gap-2">
                  {exertionProfile ? (
                    <>
                      {(
                        [
                          [
                            "Moderate",
                            `≤ typical (≤P50 within last ${RUN_LABEL_HISTORY_WINDOW} runs)`,
                          ] as const,
                          ["High", "above typical (P50–P80)"] as const,
                          ["Very high", "hard day (P80–P95)"] as const,
                          ["Max", "very rare (≥P95)"] as const,
                        ] as const
                      ).map(([level, desc]) => {
                        const c = EXERTION_LEVEL_COLORS[level];
                        return (
                          <div
                            key={level}
                            className="rounded-xl border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-surface)]/60 px-3 py-2"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                                style={{
                                  backgroundColor: `color-mix(in srgb, ${c} 22%, transparent)`,
                                  color: `color-mix(in srgb, ${c} 70%, var(--foreground))`,
                                }}
                              >
                                <span
                                  className="inline-block h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: c }}
                                />
                                {level}
                              </span>
                              <span className="text-[11px] text-stone-500">{desc}</span>
                            </div>
                          </div>
                        );
                      })}

                      <div className="text-[10px] text-stone-500">
                        Each run uses only the last {RUN_LABEL_HISTORY_WINDOW} runs ending on that
                        day (max HR in that window, adaptive HR/distance cutoffs, pace and elevation
                        baselines, and exertion percentiles). Older rows do not change when you log
                        new runs.
                      </div>
                    </>
                  ) : (
                    <div className="rounded-xl border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-surface)]/60 px-3 py-3 text-[11px] text-stone-500">
                      Not enough recent runs yet to build a personalized effort distribution (need at
                      least {MIN_SAMPLES_FOR_ROLLING_ADAPTIVE} scored activities with distance and
                      time).
                    </div>
                  )}
                </div>
              </div>
            </div>
          </details>

          <RecentRunsTable
            runs={recentRuns.map<RecentRunRow>((r) => {
              const ctx = contextByRowKey.get(r.rowKey) ?? latestContext;
              const cls = classifyRunWithReason({
                name: r.name ?? "Run",
                distanceMeters: r.distanceMeters,
                movingTimeSec: r.movingTimeSec,
                averageHrBpm: r.averageHrBpm,
                maxHrBpm: r.maxHrBpm,
                userReferenceMaxHr: ctx.userReferenceMaxHr,
                trainingProfile: ctx.trainingProfile,
              });
              const eff = explainRunExertion({
                run: {
                  distanceMeters: r.distanceMeters,
                  movingTimeSec: r.movingTimeSec,
                  averageHrBpm: r.averageHrBpm,
                  totalElevationM: r.totalElevationM,
                },
                userReferenceMaxHr: ctx.userReferenceMaxHr,
                exertionProfile: ctx.exertionProfile,
                baselines: ctx.paceElevationBaselines,
              });
              return {
                rowKey: r.rowKey,
                source: r.source,
                providerActivityId: r.providerActivityId,
                tag: cls.tag,
                exertion: eff.exertion,
                classificationReasons: cls.reasons,
                classificationThresholds: cls.thresholdsSummary,
                exertionReasons: eff.reasons,
                exertionThresholds: eff.thresholdsSummary,
                name: r.name ?? "Run",
                startAtIso: r.startAt.toISOString(),
                distanceMeters: r.distanceMeters,
                movingTimeSec: r.movingTimeSec,
                totalElevationM: r.totalElevationM,
                averageHrBpm: r.averageHrBpm,
                maxHrBpm: r.maxHrBpm,
              };
            })}
            tz={tz}
          />
        </ChartCard>
      </section>

      <RunningChat />
    </div>
  );
}
