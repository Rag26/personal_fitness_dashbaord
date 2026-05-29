import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { ActivityMonthCalendar } from "@/components/dashboard/activity-month-calendar";
import type { LiftDayBucket } from "@/components/dashboard/lifting-type-month-calendar";
import { LiftingTypeMonthCalendar } from "@/components/dashboard/lifting-type-month-calendar";
import { LiftWeeklyPlanClient } from "@/components/dashboard/lift-weekly-plan-client";
import { MuscleGroupGoalsClient } from "@/components/dashboard/muscle-group-goals-client";
import { LiftTypeSelect } from "@/components/dashboard/lift-type-select";
import { BarChartView } from "@/components/charts/bar-chart";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { chartPalette } from "@/lib/chart-palette";
import {
  emptyTemplateCounts,
  LIFT_TEMPLATE_KEYS,
  LIFT_TEMPLATE_LABELS,
  targetsToRecord,
  weekConsistencyScore,
} from "@/lib/lift-session-log";
import { fetchMergedLiftsInRange } from "@/lib/merged-lifts";
import { countMuscleGroupSessionsInRange, summarizeExerciseLine } from "@/lib/hevy-lifting-queries";
import { muscleGroupLabel } from "@/lib/hevy-muscle-groups";
import {
  activeZonedDaysOfMonth,
  localCalendarParts,
  parseCalendarYearMonth,
  startOfZonedWeekMondayContaining,
  zonedMonthRangeUtc,
} from "@/lib/zoned-calendar";
import { secondsToHhMm } from "@/lib/units";
import { formatZonedDateShort, formatZonedDateTimeLiftingCell } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";
export const dynamic = "force-dynamic";

function formatSportLabel(s: string) {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function zoneHighMinutes(zoneDurations: unknown): string {
  if (!zoneDurations || typeof zoneDurations !== "object") return "—";
  const o = zoneDurations as Record<string, number>;
  const z4 = o.zone_four_milli ?? 0;
  const z5 = o.zone_five_milli ?? 0;
  const ms = z4 + z5;
  if (ms <= 0) return "—";
  return `${Math.round(ms / 60_000)}m Z4–5`;
}

export async function LiftingSection({
  searchParams,
}: {
  searchParams?: Promise<{ y?: string; m?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();
  const now = new Date();
  const start7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(user?.timezone);
  const shortDay = (d: Date) => formatZonedDateShort(d, tz);
  const cal = parseCalendarYearMonth(sp, tz);
  const monthRange = zonedMonthRangeUtc(cal.year, cal.month1, tz);

  const thisMonday = startOfZonedWeekMondayContaining(now, tz);
  const nextMonday = new Date(thisMonday.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [
    lift7,
    lift30,
    liftMonth,
    liftSplitTargets,
    muscleGroupTargets,
    weekMuscleCounts,
  ] = await Promise.all([
    fetchMergedLiftsInRange(userId, start7, now),
    fetchMergedLiftsInRange(userId, start30, now),
    fetchMergedLiftsInRange(userId, monthRange.start, monthRange.end),
    prisma().liftSplitWeeklyTarget.findUnique({ where: { userId } }),
    prisma().muscleGroupWeeklyTarget.findMany({
      where: { userId },
      orderBy: { muscleGroup: "asc" },
      select: { muscleGroup: true, target: true },
    }),
    countMuscleGroupSessionsInRange(userId, thisMonday, nextMonday),
  ]);

  const weeklyTargets = liftSplitTargets
    ? targetsToRecord({
        pushTarget: liftSplitTargets.pushTarget,
        pullTarget: liftSplitTargets.pullTarget,
        legsTarget: liftSplitTargets.legsTarget,
      })
    : emptyTemplateCounts();

  const thisMondayMs = thisMonday.getTime();
  const thisWeekCounts = emptyTemplateCounts();
  for (const w of lift30) {
    if (w.liftSessionTemplate == null) continue;
    if (startOfZonedWeekMondayContaining(w.startAt, tz).getTime() !== thisMondayMs) {
      continue;
    }
    thisWeekCounts[w.liftSessionTemplate] += 1;
  }

  const consistencyThisWeek = weekConsistencyScore(
    thisWeekCounts,
    weeklyTargets,
  );

  const initialTargets = liftSplitTargets
    ? {
        pushTarget: liftSplitTargets.pushTarget,
        pullTarget: liftSplitTargets.pullTarget,
        legsTarget: liftSplitTargets.legsTarget,
      }
    : {
        pushTarget: 0,
        pullTarget: 0,
        legsTarget: 0,
      };

  const liftTypeDayMap = new Map<number, LiftDayBucket>();
  for (const w of liftMonth) {
    const p = localCalendarParts(w.startAt, tz);
    if (p.y !== cal.year || p.m !== cal.month1) continue;
    const dom = p.d;
    const cur = liftTypeDayMap.get(dom) ?? { templates: [], untaggedLiftCount: 0 };
    if (w.liftSessionTemplate) cur.templates.push(w.liftSessionTemplate);
    else cur.untaggedLiftCount += 1;
    liftTypeDayMap.set(dom, cur);
  }

  const activeLiftDays = activeZonedDaysOfMonth(
    liftMonth.map((w) => w.startAt),
    tz,
    cal.year,
    cal.month1,
  );

  const sessionCount = lift7.length;
  const totalSec = lift7.reduce(
    (acc, w) => acc + (w.endAt.getTime() - w.startAt.getTime()) / 1000,
    0,
  );
  const scored = lift7.filter(
    (w) => w.source === "WHOOP" && w.scoreState === "SCORED" && w.strain != null,
  );
  const avgStrain =
    scored.length > 0
      ? scored.reduce((a, w) => a + (w.strain ?? 0), 0) / scored.length
      : null;
  const hrRows = lift7.filter((w) => w.averageHeartRateBpm != null);
  const avgHr =
    hrRows.length > 0
      ? Math.round(
          hrRows.reduce((a, w) => a + (w.averageHeartRateBpm ?? 0), 0) /
            hrRows.length,
        )
      : null;

  const strainTrend = [...lift30]
    .reverse()
    .filter((w) => w.source === "WHOOP" && w.strain != null)
    .map((w) => ({
      date: shortDay(w.startAt),
      strain: Number((w.strain ?? 0).toFixed(2)),
    }));

  const hrTrend = [...lift30]
    .reverse()
    .filter((w) => w.averageHeartRateBpm != null)
    .map((w) => ({
      date: shortDay(w.startAt),
      avg: w.averageHeartRateBpm,
      max: w.maxHeartRateBpm,
    }));

  const durationTrend = [...lift30]
    .reverse()
    .map((w) => {
      const sec = (w.endAt.getTime() - w.startAt.getTime()) / 1000;
      return {
        date: shortDay(w.startAt),
        min: Number((sec / 60).toFixed(1)),
      };
    });

  const tableRows = lift30.slice(0, 40);

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Sessions" value={String(sessionCount)} hint="Hevy + WHOOP · 7d" />
        <StatCard
          title="Time training"
          value={totalSec > 0 ? secondsToHhMm(Math.round(totalSec)) : "—"}
          hint="Hevy + WHOOP · 7d"
        />
        <StatCard
          title="Avg strain"
          value={avgStrain != null ? avgStrain.toFixed(1) : "—"}
          hint="Scored WHOOP workouts · 7d"
        />
        <StatCard title="Avg HR" value={avgHr != null ? `${avgHr} bpm` : "—"} hint="Hevy + WHOOP · 7d" />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Workout strain" description="Per session · last 30d · lower = easier" className="lg:col-span-2">
          <BarChartView
            data={strainTrend}
            xKey="date"
            yKey="strain"
            color={chartPalette.cal}
            yUnit=""
          />
        </ChartCard>
        <ActivityMonthCalendar
          basePath="/train"
          variant="/lifting"
          year={cal.year}
          month1={cal.month1}
          timeZone={tz}
          activeDays={activeLiftDays}
          legendLabel="lift"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Session duration" description="Minutes · session start→end">
          <BarChartView data={durationTrend} xKey="date" yKey="min" color={chartPalette.amazon} yUnit=" min" />
        </ChartCard>
        <ChartCard title="Workout heart rate" description="Avg and max per session · last 30d">
          <MultiLineChartView
            data={hrTrend}
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

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-stretch">
        <ChartCard
          title="Lift types · month"
          description="Hevy workouts by day — cell color shows push, pull, or legs (stone = not classified yet)"
          className="flex min-h-0 flex-col lg:col-span-2 lg:h-full"
          contentClassName="flex min-h-0 flex-1 flex-col pt-0"
        >
          <LiftingTypeMonthCalendar
            year={cal.year}
            month1={cal.month1}
            timeZone={tz}
            dayMap={liftTypeDayMap}
            className="flex min-h-0 w-full flex-1 flex-col"
          />
        </ChartCard>
        <div className="flex min-h-0 flex-col gap-4 lg:col-span-1 lg:min-h-0 lg:h-full">
          <StatCard
            fillHeight
            className="min-h-0 flex-1"
            title="This week vs plan"
            value={
              consistencyThisWeek != null
                ? `${Math.round(consistencyThisWeek * 100)}%`
                : "Set targets"
            }
            hint={
              consistencyThisWeek != null
                ? "Tagged push/pull/legs this week vs plan (capped at 100%)"
                : "Set weekly targets and tag workouts below"
            }
          />
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[color:var(--color-border-subtle)] bg-card/55 p-4 text-sm shadow-sm shadow-black/[0.04]">
            <div className="shrink-0 text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
              Current week counts
            </div>
            <ul className="mt-3 flex flex-1 flex-col justify-center gap-2 text-stone-700">
              {LIFT_TEMPLATE_KEYS.map((key) => {
                const t = weeklyTargets[key];
                const a = thisWeekCounts[key];
                const label = LIFT_TEMPLATE_LABELS[key];
                return (
                  <li key={key} className="flex justify-between gap-2 text-xs">
                    <span>{label}</span>
                    <span className="tabular-nums text-stone-600">
                      {a}/{t > 0 ? t : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Weekly split plan"
          description="Session-level push / pull / legs targets — actuals come from auto-classification of each Hevy workout (you can override per row below)"
          contentClassName="pt-0"
        >
          <LiftWeeklyPlanClient initialTargets={initialTargets} />
        </ChartCard>
        <ChartCard
          title="Muscle group targets"
          description="Per-muscle-group session targets (e.g. abs 3x, shoulders 3x). One Hevy workout can tick multiple groups."
          contentClassName="pt-0"
        >
          <MuscleGroupGoalsClient initialTargets={muscleGroupTargets} />
        </ChartCard>
      </section>

      {muscleGroupTargets.length > 0 ? (
        <ChartCard
          title="This week · muscle groups"
          description="Sessions hit this week vs target (Mon–Sun in your timezone)"
        >
          <ul className="grid gap-2 px-6 pb-6 text-sm text-stone-700 sm:grid-cols-2 lg:grid-cols-3">
            {muscleGroupTargets.map((t) => {
              const hit = weekMuscleCounts[t.muscleGroup] ?? 0;
              const goal = t.target;
              const done = goal > 0 && hit >= goal;
              return (
                <li
                  key={t.muscleGroup}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border-subtle)] bg-card/55 px-3 py-2"
                >
                  <span className="font-medium text-[color:var(--color-text-primary)]">
                    {muscleGroupLabel(t.muscleGroup)}
                  </span>
                  <span
                    className={
                      done
                        ? "tabular-nums text-[color:var(--ui-accent)]"
                        : "tabular-nums text-stone-600"
                    }
                  >
                    {hit}/{goal > 0 ? goal : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </ChartCard>
      ) : null}

      <section>
        <ChartCard
          title="Recent strength workouts"
          description="Last 40 sessions in the last 30 days. Hevy rows show exercises + sets; WHOOP-matched rows pick up strain & Z4–5. Push / pull / legs auto-tagged from Hevy exercise muscle groups — change to override."
          contentClassName="pt-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="text-[10px] tracking-wider text-stone-500 uppercase">
                <tr>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-left font-medium">Start</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-left font-medium">Session type</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-left font-medium">Source</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-left font-medium">Workout</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-right font-medium">Duration</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-right font-medium">Strain</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-right font-medium">Avg HR</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-right font-medium">Max HR</th>
                  <th className="sticky top-0 bg-card/85 px-3 py-2.5 text-right font-medium">Z4–5</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length > 0 ? (
                  tableRows.map((w) => {
                    const sec = (w.endAt.getTime() - w.startAt.getTime()) / 1000;
                    const isHevy = w.source === "HEVY";
                    const sourceLabel = isHevy
                      ? w.whoopMatch
                        ? "HEVY + WHOOP"
                        : "HEVY"
                      : "WHOOP";
                    return (
                      <tr
                        key={`${w.source}:${w.id}`}
                        className="border-t border-[color:var(--color-border-subtle)] transition-colors hover:bg-[color:var(--ui-accent-soft)]"
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 align-top text-stone-500">
                          {formatZonedDateTimeLiftingCell(w.startAt, tz)}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <LiftTypeSelect
                            initial={w.liftSessionTemplate}
                            endpoint={
                              isHevy
                                ? `/api/hevy-workouts/${w.id}/lift-template`
                                : `/api/whoop-workouts/${w.id}/lift-template`
                            }
                          />
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <span
                            className={
                              isHevy
                                ? "rounded-md bg-[color:var(--ui-accent-3-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[color:var(--ui-accent-3)] uppercase"
                                : "rounded-md bg-[color:var(--ui-accent-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[color:var(--ui-accent)] uppercase"
                            }
                          >
                            {sourceLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {isHevy ? (
                            <div>
                              <div className="font-medium text-[color:var(--color-text-primary)]">
                                {w.title}
                              </div>
                              {w.exercises.length > 0 ? (
                                <ul className="mt-1 space-y-0.5 text-xs text-stone-500">
                                  {w.exercises.slice(0, 4).map((ex) => (
                                    <li key={ex.index} className="truncate">
                                      {summarizeExerciseLine(ex)}
                                    </li>
                                  ))}
                                  {w.exercises.length > 4 ? (
                                    <li className="text-stone-400">
                                      +{w.exercises.length - 4} more
                                    </li>
                                  ) : null}
                                </ul>
                              ) : null}
                              {w.muscleGroups.length > 0 ? (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {w.muscleGroups.slice(0, 6).map((g) => (
                                    <span
                                      key={g}
                                      className="rounded bg-[color:var(--ui-accent-soft)] px-1.5 py-0.5 text-[10px] tracking-wide text-[color:var(--ui-accent)]"
                                    >
                                      {muscleGroupLabel(g)}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="font-medium text-[color:var(--color-text-primary)]">
                              {formatSportLabel(w.sportName)}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-stone-700">
                          {sec > 0 ? secondsToHhMm(Math.round(sec)) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-stone-700">
                          {w.strain != null ? w.strain.toFixed(2) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-stone-700">
                          {w.averageHeartRateBpm ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-stone-700">
                          {w.maxHeartRateBpm ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-stone-700">
                          {zoneHighMinutes(w.zoneDurations)}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-stone-500">
                      No lifting workouts in the last 30 days. Log a session in Hevy and click
                      &ldquo;Sync now&rdquo; on Settings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </section>
    </div>
  );
}
