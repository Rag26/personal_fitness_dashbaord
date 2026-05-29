import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { BarChartView } from "@/components/charts/bar-chart";
import { AreaChartView } from "@/components/charts/area-chart";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { chartPalette } from "@/lib/chart-palette";
import { lastNCalendarUtcDaysInclusive } from "@/lib/calendar-range";
import { formatPaceMinPerMile, kgToLb, metersToMiles, minutesToHhMm } from "@/lib/units";
import { formatZonedWeekOfLine, formatZonedYearMonthShort } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";

export const dynamic = "force-dynamic";

function weekStartMondayUtc(date: Date) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - delta);
  return d;
}

export async function JourneySection() {
  const userId = await requireUserId();
  const userTz = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userTz?.timezone);
  const ymLabel = (year: number, month: number) => formatZonedYearMonthShort(year, month, tz);
  const weekLabel = (d: Date) => formatZonedWeekOfLine(d, tz);
  const now = new Date();
  const { start: winStart, end: winEnd } = lastNCalendarUtcDaysInclusive(30, now);

  const threeYearsAgo = new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 1));

  const [snapshots, whoopLast30, whoopSleep30, allWhoopDaily] = await Promise.all([
    prisma().monthlyFitnessSnapshot.findMany({
      where: { userId },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: winStart, lte: winEnd } },
      select: { recoveryScore: true },
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: winStart, lte: winEnd } },
      select: { date: true, sleepMinutes: true },
      orderBy: { date: "asc" },
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: threeYearsAgo } },
      select: {
        date: true,
        sleepMinutes: true,
        weightKg: true,
        recoveryScore: true,
        strain: true,
        hrvRmssdMs: true,
      },
    }),
  ]);

  const sleepMonthAgg = new Map<string, { sumMin: number; n: number }>();
  for (const r of allWhoopDaily) {
    if (r.sleepMinutes == null || r.sleepMinutes <= 0) continue;
    const key = `${r.date.getUTCFullYear()}-${r.date.getUTCMonth() + 1}`;
    const cur = sleepMonthAgg.get(key) ?? { sumMin: 0, n: 0 };
    cur.sumMin += r.sleepMinutes;
    cur.n += 1;
    sleepMonthAgg.set(key, cur);
  }
  const sleepHrs = [...sleepMonthAgg.entries()]
    .map(([key, v]) => {
      const [y, m] = key.split("-").map(Number);
      return {
        period: ymLabel(y, m),
        sortKey: y * 100 + m,
        hours: v.n > 0 ? Number((v.sumMin / v.n / 60).toFixed(2)) : 0,
      };
    })
    .filter((r) => r.hours > 0)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ period, hours }) => ({ period, hours }));

  const thisYear = now.getFullYear();
  const lastYear = thisYear - 1;

  const runMi = snapshots
    .filter((s) => (s.runDistanceMeters ?? 0) > 0)
    .map((s) => ({
      period: ymLabel(s.year, s.month),
      mi: Number(metersToMiles(s.runDistanceMeters ?? 0).toFixed(1)),
    }));

  const paceMin = snapshots
    .filter((s) => s.avgPaceSecPerMi != null && s.avgPaceSecPerMi > 0)
    .map((s) => ({
      period: ymLabel(s.year, s.month),
      pace: Number((s.avgPaceSecPerMi! / 60).toFixed(2)),
    }));

  type WhoopWeekBucket = {
    sumKg: number;
    nKg: number;
    sumRec: number;
    nRec: number;
    sumStrain: number;
    nStrain: number;
    sumHrv: number;
    nHrv: number;
  };
  const emptyBucket = (): WhoopWeekBucket => ({
    sumKg: 0, nKg: 0, sumRec: 0, nRec: 0, sumStrain: 0, nStrain: 0, sumHrv: 0, nHrv: 0,
  });

  const whoopWeekBuckets = new Map<number, WhoopWeekBucket>();
  for (const r of allWhoopDaily) {
    const wkKey = weekStartMondayUtc(r.date).getTime();
    const b = whoopWeekBuckets.get(wkKey) ?? emptyBucket();

    if (r.weightKg != null && Number.isFinite(r.weightKg) && r.weightKg > 0) {
      b.sumKg += r.weightKg;
      b.nKg += 1;
    }
    if (r.recoveryScore != null && Number.isFinite(r.recoveryScore)) {
      b.sumRec += r.recoveryScore;
      b.nRec += 1;
    }
    if (r.strain != null && Number.isFinite(r.strain)) {
      b.sumStrain += r.strain;
      b.nStrain += 1;
    }
    if (r.hrvRmssdMs != null && Number.isFinite(r.hrvRmssdMs)) {
      b.sumHrv += r.hrvRmssdMs;
      b.nHrv += 1;
    }

    whoopWeekBuckets.set(wkKey, b);
  }

  const sortedWeekKeys = [...whoopWeekBuckets.entries()].sort(
    ([a], [b]) => a - b,
  );

  const weightLb = sortedWeekKeys
    .filter(([, b]) => b.nKg > 0)
    .map(([k, b]) => ({
      period: weekLabel(new Date(k)),
      lb: Number(kgToLb(b.sumKg / b.nKg).toFixed(1)),
    }));

  const whoopRecovery = sortedWeekKeys
    .filter(([, b]) => b.nRec > 0)
    .map(([k, b]) => ({
      period: weekLabel(new Date(k)),
      recovery: Math.round(b.sumRec / b.nRec),
    }));

  const whoopHrv = sortedWeekKeys
    .filter(([, b]) => b.nHrv > 0)
    .map(([k, b]) => ({
      period: weekLabel(new Date(k)),
      hrv: Math.round(b.sumHrv / b.nHrv),
    }));

  const whoopRecStrainDual = sortedWeekKeys
    .filter(([, b]) => b.nRec > 0 || b.nStrain > 0)
    .map(([k, b]) => ({
      period: weekLabel(new Date(k)),
      recovery: b.nRec > 0 ? Math.round(b.sumRec / b.nRec) : null,
      strain: b.nStrain > 0 ? Number((b.sumStrain / b.nStrain).toFixed(1)) : null,
    }));

  const monthShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const yoyData = monthShort.map((m, i) => {
    const mo = i + 1;
    const a = snapshots.find((s) => s.year === lastYear && s.month === mo);
    const b = snapshots.find((s) => s.year === thisYear && s.month === mo);
    return {
      month: m,
      [String(lastYear)]: a?.runDistanceMeters
        ? Number(metersToMiles(a.runDistanceMeters).toFixed(1))
        : null,
      [String(thisYear)]: b?.runDistanceMeters
        ? Number(metersToMiles(b.runDistanceMeters).toFixed(1))
        : null,
    };
  });

  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  const monthsTracked = snapshots.length;

  const rec30 = whoopLast30.filter((r) => r.recoveryScore != null);
  const avgWhoopRecovery30d =
    rec30.length > 0
      ? Math.round(rec30.reduce((a, r) => a + (r.recoveryScore ?? 0), 0) / rec30.length)
      : null;

  const sleep30vals = whoopSleep30
    .map((r) => r.sleepMinutes)
    .filter((m): m is number => m != null && m > 0);
  const latestSleepAvgMin =
    sleep30vals.length > 0
      ? Math.round(sleep30vals.reduce((a, v) => a + v, 0) / sleep30vals.length)
      : null;

  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="Months tracked"
          value={monthsTracked > 0 ? String(monthsTracked) : "—"}
          hint="Snapshot rows in DB"
        />
        <StatCard
          title="Earliest month"
          value={first ? ymLabel(first.year, first.month) : "—"}
          hint="First rollup period"
        />
        <StatCard
          title="Latest pace (runs)"
          value={
            latest?.avgPaceSecPerMi != null && latest.avgPaceSecPerMi > 0
              ? formatPaceMinPerMile(latest.avgPaceSecPerMi)
              : "—"
          }
          hint="Strava · monthly weighted"
        />
        <StatCard
          title="Sleep (avg)"
          value={latestSleepAvgMin != null ? minutesToHhMm(latestSleepAvgMin) : "—"}
          hint="WHOOP · last 30 UTC days"
        />
        <StatCard
          title="WHOOP recovery"
          value={avgWhoopRecovery30d != null ? `${avgWhoopRecovery30d}%` : "—"}
          hint="Last 30 UTC calendar days"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Monthly run volume"
          description="Strava runs · miles per calendar month"
        >
          <BarChartView
            data={runMi}
            xKey="period"
            yKey="mi"
            color={chartPalette.amazon}
            yUnit=" mi"
            height={260}
          />
        </ChartCard>
        <ChartCard
          title="Average pace by month"
          description="Strava · lower is faster"
        >
          <AreaChartView
            data={paceMin}
            xKey="period"
            yKey="pace"
            color={chartPalette.cal}
            yUnit=" min/mi"
            gradientId="j-pace"
            height={260}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Sleep (monthly average)"
          description="WHOOP · nightly sleep, averaged per month"
        >
          <AreaChartView
            data={sleepHrs}
            xKey="period"
            yKey="hours"
            color={chartPalette.un}
            yUnit=" h"
            gradientId="j-sleep"
            height={260}
          />
        </ChartCard>
        <ChartCard
          title="Body weight (weekly average)"
          description="WHOOP body measurement · lb · averaged by week"
        >
          <AreaChartView
            data={weightLb}
            xKey="period"
            yKey="lb"
            color={chartPalette.gia}
            yUnit=" lb"
            gradientId="j-wt"
            height={260}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="WHOOP recovery vs strain"
          description="Weekly averages"
          className="lg:col-span-2"
        >
          <MultiLineChartView
            data={whoopRecStrainDual}
            xKey="period"
            lines={[
              { dataKey: "recovery", color: "#22c55e", name: "Recovery %", yAxisId: "left" },
              { dataKey: "strain", color: chartPalette.adobe, name: "Strain", yAxisId: "right" },
            ]}
            yDomain={[0, 100]}
            rightYDomain={[0, "dataMax"]}
            height={260}
          />
        </ChartCard>
        <ChartCard title="WHOOP recovery %" description="Weekly average">
          <AreaChartView
            data={whoopRecovery}
            xKey="period"
            yKey="recovery"
            color="#22c55e"
            yUnit="%"
            gradientId="j-wrec"
            height={240}
            yDomain={[0, 100]}
          />
        </ChartCard>
        <ChartCard title="WHOOP HRV" description="Weekly avg RMSSD (ms)">
          <AreaChartView
            data={whoopHrv}
            xKey="period"
            yKey="hrv"
            color="#22c55e"
            yUnit=" ms"
            gradientId="j-whrv"
            height={240}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section>
        <ChartCard
          title="Year-over-year run volume"
          description={`Strava · ${lastYear} vs ${thisYear} (same calendar month)`}
        >
          <MultiLineChartView
            data={yoyData}
            xKey="month"
            lines={[
              {
                dataKey: String(lastYear),
                color: chartPalette.un,
                name: `${lastYear} (mi)`,
              },
              {
                dataKey: String(thisYear),
                color: chartPalette.amazon,
                name: `${thisYear} (mi)`,
              },
            ]}
            height={280}
            yDomain={[0, "dataMax"]}
          />
        </ChartCard>
      </section>
    </div>
  );
}
