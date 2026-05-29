import { ChartCard } from "@/components/dashboard/chart-card";
import { AreaChartView } from "@/components/charts/area-chart";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { chartPalette } from "@/lib/chart-palette";
import { formatZonedDateShort } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";

/**
 * Recovery detail = the WHOOP recovery/sleep/HRV/RHR chart stack, surfaced
 * below the fold on the Today page. Stat rows and the body-weight chart live
 * elsewhere (Today readiness row, Nutrition/Progress respectively).
 */
export async function RecoveryDetail() {
  const userId = await requireUserId();
  const userTz = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userTz?.timezone);
  const shortDay = (d: Date) => formatZonedDateShort(d, tz);
  const now = new Date();
  const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const whoopMonth = await prisma().dailyWhoopStat.findMany({
    where: { userId, date: { gte: start30 } },
    select: {
      date: true,
      recoveryScore: true,
      strain: true,
      hrvRmssdMs: true,
      sleepMinutes: true,
      sleepPerformancePct: true,
      sleepEfficiencyPct: true,
      restingHeartRateBpm: true,
    },
    orderBy: { date: "asc" },
  });

  const rhrData = whoopMonth
    .filter((r) => r.restingHeartRateBpm != null && r.restingHeartRateBpm > 0)
    .map((r) => ({
      day: formatZonedDateShort(r.date, tz),
      bpm: r.restingHeartRateBpm,
    }));

  const whoopRecStrainData = whoopMonth
    .filter((r) => r.recoveryScore != null || r.strain != null)
    .map((r) => ({
      day: shortDay(r.date),
      recovery: r.recoveryScore,
      strain: r.strain != null ? Number(r.strain.toFixed(1)) : null,
    }));

  const whoopHrvData = whoopMonth
    .filter((r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0)
    .map((r) => ({
      day: shortDay(r.date),
      hrv: Math.round(r.hrvRmssdMs ?? 0),
    }));

  const whoopSleepPerfData = whoopMonth
    .filter((r) => r.sleepPerformancePct != null)
    .map((r) => ({
      day: shortDay(r.date),
      perf: Number((r.sleepPerformancePct ?? 0).toFixed(0)),
    }));

  const whoopSleepEffData = whoopMonth
    .filter((r) => r.sleepEfficiencyPct != null)
    .map((r) => ({
      day: shortDay(r.date),
      eff: Number((r.sleepEfficiencyPct ?? 0).toFixed(0)),
    }));

  const whoopSleepHoursData = whoopMonth
    .filter((r) => r.sleepMinutes != null && r.sleepMinutes > 0)
    .map((r) => ({
      day: shortDay(r.date),
      hours: Number(((r.sleepMinutes ?? 0) / 60).toFixed(1)),
    }));

  return (
    <div className="space-y-4">
      <section className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Recovery vs strain" description="Last 30 days">
          <MultiLineChartView
            data={whoopRecStrainData}
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
        <ChartCard title="HRV (RMSSD)" description="Heart rate variability · last 30 days">
          <AreaChartView
            data={whoopHrvData}
            xKey="day"
            yKey="hrv"
            color="#22c55e"
            yUnit=" ms"
            gradientId="rec-hrv"
            height={240}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
        <ChartCard title="Sleep performance %" description="WHOOP sleep score · last 30 days">
          <AreaChartView
            data={whoopSleepPerfData}
            xKey="day"
            yKey="perf"
            color={chartPalette.un}
            yUnit="%"
            gradientId="rec-sp"
            height={220}
            yDomain={[0, 100]}
          />
        </ChartCard>
        <ChartCard title="Sleep efficiency %" description="WHOOP · last 30 days">
          <AreaChartView
            data={whoopSleepEffData}
            xKey="day"
            yKey="eff"
            color={chartPalette.cal}
            yUnit="%"
            gradientId="rec-se"
            height={220}
            yDomain={[0, 100]}
          />
        </ChartCard>
        <ChartCard title="Time in bed" description="WHOOP main sleep duration · last 30 days" className="lg:col-span-2">
          <AreaChartView
            data={whoopSleepHoursData}
            xKey="day"
            yKey="hours"
            color={chartPalette.gia}
            yUnit=" h"
            gradientId="rec-slph"
            height={200}
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4">
        <ChartCard title="Resting heart rate" description="WHOOP · 30-day trend">
          <AreaChartView
            data={rhrData}
            xKey="day"
            yKey="bpm"
            color={chartPalette.gia}
            gradientId="rhr-rec"
            yDomain={["dataMin", "dataMax"]}
          />
        </ChartCard>
      </section>
    </div>
  );
}
