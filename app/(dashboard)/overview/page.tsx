import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { CombinedMonthCalendar } from "@/components/dashboard/combined-month-calendar";
import { BarChartView } from "@/components/charts/bar-chart";
import { AreaChartView } from "@/components/charts/area-chart";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { fetchStravaRunsInRange, fetchStravaRunStartsInRange } from "@/lib/merged-runs";
import { fetchMergedLiftStartsInRange } from "@/lib/merged-lifts";
import {
  activeZonedDaysOfMonth,
  parseCalendarYearMonth,
  zonedMonthRangeUtc,
} from "@/lib/zoned-calendar";
import { chartPalette } from "@/lib/chart-palette";
import {
  formatPaceMinPerMile,
  metersToMiles,
  minutesToHhMm,
  paceSecondsPerMile,
  secondsToHhMm,
} from "@/lib/units";
import {
  formatZonedDateShort,
  formatZonedWeekdayShortMonthDay,
} from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";

export const dynamic = "force-dynamic";

function zonedDayKey(d: Date, timeZone: string) {
  // YYYY-MM-DD in the user's timezone (prevents UTC day shifting).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function getGreeting(hour: number) {
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<{ y?: string; m?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();
  const now = new Date();
  const start7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [user, activities7, whoopWeek, whoop30] = await Promise.all([
    prisma().user.findUnique({
      where: { id: userId },
      select: { firstName: true, timezone: true },
    }),
    fetchStravaRunsInRange(userId, start7, now),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: start7 } },
      select: {
        date: true,
        recoveryScore: true,
        strain: true,
        hrvRmssdMs: true,
        sleepMinutes: true,
        restingHeartRateBpm: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: start30 } },
      select: {
        date: true,
        recoveryScore: true,
        strain: true,
        hrvRmssdMs: true,
        sleepMinutes: true,
        restingHeartRateBpm: true,
      },
      orderBy: { date: "asc" },
    }),
  ]);

  const tz = normalizeUserTimezone(user?.timezone);
  const dayLabel = (d: Date) => formatZonedWeekdayShortMonthDay(d, tz);
  const shortDay = (d: Date) => formatZonedDateShort(d, tz);

  const totalMeters = activities7.reduce((a, r) => a + (r.distanceMeters ?? 0), 0);
  const totalSeconds = activities7.reduce((a, r) => a + (r.movingTimeSec ?? 0), 0);
  const miles = metersToMiles(totalMeters);
  const pace = formatPaceMinPerMile(paceSecondsPerMile({ seconds: totalSeconds, meters: totalMeters }));

  const sleepMinutes30 = whoop30
    .map((r) => r.sleepMinutes)
    .filter((m): m is number => m != null && m > 0);
  const sleepAvgMin =
    sleepMinutes30.length > 0
      ? Math.round(sleepMinutes30.reduce((a, v) => a + v, 0) / sleepMinutes30.length)
      : null;

  const rhrRows7 = whoopWeek.filter((r) => r.restingHeartRateBpm != null && r.restingHeartRateBpm > 0);
  const rhrAvg =
    rhrRows7.length > 0
      ? Math.round(rhrRows7.reduce((a, r) => a + (r.restingHeartRateBpm ?? 0), 0) / rhrRows7.length)
      : null;

  const whoopRec = whoopWeek.filter((r) => r.recoveryScore != null);
  const whoopAvgRecovery =
    whoopRec.length > 0
      ? Math.round(whoopRec.reduce((a, r) => a + (r.recoveryScore ?? 0), 0) / whoopRec.length)
      : null;
  const whoopStr = whoopWeek.filter((r) => r.strain != null);
  const whoopAvgStrain =
    whoopStr.length > 0 ? whoopStr.reduce((a, r) => a + (r.strain ?? 0), 0) / whoopStr.length : null;
  const whoopHrv = whoopWeek.filter((r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0);
  const whoopAvgHrv =
    whoopHrv.length > 0 ? whoopHrv.reduce((a, r) => a + (r.hrvRmssdMs ?? 0), 0) / whoopHrv.length : null;

  const distByDay = new Map<string, { label: string; mi: number }>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    distByDay.set(zonedDayKey(d, tz), { label: dayLabel(d), mi: 0 });
  }
  for (const a of activities7) {
    const key = zonedDayKey(a.startAt, tz);
    const entry = distByDay.get(key);
    if (entry) entry.mi += metersToMiles(a.distanceMeters ?? 0);
  }
  const distData = [...distByDay.values()].map((d) => ({
    day: d.label,
    mi: Number(d.mi.toFixed(2)),
  }));

  const sleepData = whoop30
    .filter((r) => r.sleepMinutes != null && r.sleepMinutes > 0)
    .map((r) => ({
      day: formatZonedDateShort(r.date, tz),
      hours: Number(((r.sleepMinutes ?? 0) / 60).toFixed(1)),
    }));

  const rhrData = whoop30
    .filter((r) => r.restingHeartRateBpm != null && r.restingHeartRateBpm > 0)
    .map((r) => ({
      day: formatZonedDateShort(r.date, tz),
      bpm: r.restingHeartRateBpm,
    }));

  const whoopRecStrainData = whoop30
    .filter((r) => r.recoveryScore != null || r.strain != null)
    .map((r) => ({
      day: shortDay(r.date),
      recovery: r.recoveryScore,
      strain: r.strain != null ? Number(r.strain.toFixed(1)) : null,
    }));

  const whoopHrvData = whoop30
    .filter((r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0)
    .map((r) => ({
      day: shortDay(r.date),
      hrv: Math.round(r.hrvRmssdMs ?? 0),
    }));

  const cal = parseCalendarYearMonth(sp, tz);
  const monthRange = zonedMonthRangeUtc(cal.year, cal.month1, tz);

  const [runStartsMonth, liftStartsMonth] = await Promise.all([
    fetchStravaRunStartsInRange(userId, monthRange.start, monthRange.end),
    fetchMergedLiftStartsInRange(userId, monthRange.start, monthRange.end),
  ]);

  const activeRunDays = activeZonedDaysOfMonth(runStartsMonth, tz, cal.year, cal.month1);
  const activeLiftDays = activeZonedDaysOfMonth(liftStartsMonth, tz, cal.year, cal.month1);

  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).format(now),
  );
  const greeting = getGreeting(Number.isFinite(localHour) ? localHour : 12);
  const firstName = user?.firstName?.trim() || "there";

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
          {greeting}, {firstName}
        </h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
          Your weekly snapshot across running, recovery, and sleep.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Distance" value={`${miles.toFixed(1)} mi`} hint="Strava · 7d" />
        <StatCard title="Time" value={secondsToHhMm(totalSeconds)} hint="Strava · 7d" />
        <StatCard title="Avg pace" value={pace} hint="Strava · 7d" />
        <StatCard title="Runs" value={String(activities7.length)} hint="Strava · 7d" />
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard title="Sleep (avg)" value={minutesToHhMm(sleepAvgMin)} hint="WHOOP · 30d" />
        <StatCard title="Resting HR" value={rhrAvg != null ? `${rhrAvg} bpm` : "—"} hint="WHOOP · 7d avg" />
        <StatCard
          title="Recovery"
          value={whoopAvgRecovery != null ? `${whoopAvgRecovery}%` : "—"}
          hint="WHOOP · 7d avg"
        />
        <StatCard
          title="Strain"
          value={whoopAvgStrain != null ? whoopAvgStrain.toFixed(1) : "—"}
          hint="WHOOP · 7d avg"
        />
        <StatCard
          title="HRV"
          value={whoopAvgHrv != null ? `${Math.round(whoopAvgHrv)} ms` : "—"}
          hint="WHOOP · 7d RMSSD"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Distance by day" description="Miles from Strava runs · 7d" className="lg:col-span-2">
          <BarChartView data={distData} xKey="day" yKey="mi" color={chartPalette.amazon} yUnit=" mi" />
        </ChartCard>
        <CombinedMonthCalendar
          basePath="/overview"
          year={cal.year}
          month1={cal.month1}
          timeZone={tz}
          runDays={activeRunDays}
          liftDays={activeLiftDays}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Sleep"
          description={
            sleepAvgMin != null
              ? `WHOOP · ~${minutesToHhMm(sleepAvgMin)} avg · 30d`
              : "No sleep in the last 30 days"
          }
        >
          <AreaChartView data={sleepData} xKey="day" yKey="hours" color={chartPalette.un} yUnit=" h" gradientId="sleep" />
        </ChartCard>
        <ChartCard title="Resting heart rate" description="WHOOP · 30d">
          <AreaChartView
            data={rhrData}
            xKey="day"
            yKey="bpm"
            color={chartPalette.gia}
            yUnit=""
            gradientId="rhr"
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="WHOOP recovery vs strain" description="Daily scores · last 30 days">
          <MultiLineChartView
            data={whoopRecStrainData}
            xKey="day"
            lines={[
              { dataKey: "recovery", color: "#22c55e", name: "Recovery %", yAxisId: "left" },
              { dataKey: "strain", color: chartPalette.adobe, name: "Strain", yAxisId: "right" },
            ]}
            yDomain={[0, 100]}
            rightYDomain={[0, "dataMax"]}
            height={220}
          />
        </ChartCard>
        <ChartCard title="Heart rate variability" description="WHOOP HRV (RMSSD) · 30d">
          <AreaChartView
            data={whoopHrvData}
            xKey="day"
            yKey="hrv"
            color="#22c55e"
            yUnit=" ms"
            gradientId="ov-hrv"
            height={220}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>
    </div>
  );
}
