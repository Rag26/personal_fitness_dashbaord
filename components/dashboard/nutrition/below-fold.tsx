import "server-only";

import { ChartCard } from "@/components/dashboard/chart-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { MultiLineChartView } from "@/components/charts/multi-line-chart";
import { prisma } from "@/lib/db";
import { chartPalette } from "@/lib/chart-palette";
import { formatZonedDateShort, zonedDayKeyFromDate } from "@/lib/format-zoned";
import {
  addCalendarDaysToZonedParts,
  canonicalZonedDayStart,
  localCalendarParts,
  nextZonedCalendarDayStartMs,
  startOfZonedCalendarDay,
} from "@/lib/zoned-calendar";
import {
  ageYearsAt,
  buildPerDayWeightKg,
  mifflinStJeorBmrKcal,
  type BiologicalSex,
} from "@/lib/nutrition-burn";

const WINDOW_DAYS = 60;

/**
 * Partial-logged days often produce implausibly low daily totals. We treat days
 * at or below this intake floor as untrusted and omit them from averages and
 * charts so burn/deficit math isn't skewed.
 */
const MIN_TRUSTED_CONSUMED_KCAL = 900;

/** One calendar day's summed intake (from FoodLogEntry rows). */
type DayRow = {
  dayKey: string;
  date: Date;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

function hasTrustedIntake(d: DayRow): boolean {
  return Number.isFinite(d.caloriesKcal) && d.caloriesKcal > MIN_TRUSTED_CONSUMED_KCAL;
}

function dayLabel(d: Date, tz: string) {
  return formatZonedDateShort(d, tz);
}

export async function NutritionBelowFold({
  userId,
  tz,
  todayIso,
}: {
  userId: string;
  tz: string;
  todayIso: string;
}) {
  void todayIso; // logging happens in FoodLogger above; this is the trend view.
  const now = new Date();

  /**
   * 60-day rolling window aligned to user-timezone calendar days. Derive the
   * oldest day in TZ-aware steps so DST doesn't shave or pad the window.
   */
  const projectionStart = (() => {
    const tp = localCalendarParts(now, tz);
    const oldest = addCalendarDaysToZonedParts(
      tp.y,
      tp.m,
      tp.d,
      -(WINDOW_DAYS - 1),
      tz,
    );
    return startOfZonedCalendarDay(oldest.y, oldest.m, oldest.d, tz);
  })();

  const [profile, foodLog, whoopEnergy, weightWhoop, weightManual] =
    await Promise.all([
      prisma().user.findUnique({
        where: { id: userId },
        select: {
          heightCm: true,
          dateOfBirth: true,
          biologicalSex: true,
        },
      }),
      // Intake: per-food MANUAL log (the live source). Summed per day below.
      prisma().foodLogEntry.findMany({
        where: { userId, date: { gte: projectionStart } },
        select: {
          date: true,
          caloriesKcal: true,
          proteinG: true,
          carbsG: true,
          fatG: true,
        },
        orderBy: { date: "asc" },
      }),
      // Burn: WHOOP full-day energy (TDEE). Separate query from the weight one
      // below, which filters on weightKg (would exclude energy-only days).
      prisma().dailyWhoopStat.findMany({
        where: { userId, energyKcal: { not: null }, date: { gte: projectionStart } },
        select: { date: true, energyKcal: true },
      }),
      prisma().dailyWhoopStat.findMany({
        where: { userId, weightKg: { not: null } },
        select: { date: true, weightKg: true },
        orderBy: { date: "asc" },
      }),
      prisma().manualWeightLog.findMany({
        where: { userId },
        select: { date: true, weightKg: true },
        orderBy: { date: "asc" },
      }),
    ]);

  // Sum FoodLogEntry rows into one row per user-tz calendar day.
  const dayByKey = new Map<string, DayRow>();
  for (const fe of foodLog) {
    const dayKey = zonedDayKeyFromDate(fe.date, tz);
    const cur = dayByKey.get(dayKey);
    if (cur) {
      cur.caloriesKcal += fe.caloriesKcal;
      cur.proteinG += fe.proteinG;
      cur.carbsG += fe.carbsG;
      cur.fatG += fe.fatG;
    } else {
      dayByKey.set(dayKey, {
        dayKey,
        date: fe.date,
        caloriesKcal: fe.caloriesKcal,
        proteinG: fe.proteinG,
        carbsG: fe.carbsG,
        fatG: fe.fatG,
      });
    }
  }
  const merged = [...dayByKey.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  const mergedTrusted = merged.filter(hasTrustedIntake);
  const trustedHint = `Days with consumed > ${MIN_TRUSTED_CONSUMED_KCAL} kcal · last ${WINDOW_DAYS}d`;

  /** Average a macro over trusted-intake days where the value is positive. */
  const avg = (key: "caloriesKcal" | "proteinG" | "carbsG" | "fatG") => {
    let sum = 0;
    let n = 0;
    for (const d of mergedTrusted) {
      const v = d[key];
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        n += 1;
      }
    }
    return n > 0 ? sum / n : null;
  };

  const avgCalories = avg("caloriesKcal");
  const avgProtein = avg("proteinG");
  const avgCarbs = avg("carbsG");
  const avgFat = avg("fatG");

  // WHOOP full-day burn (kcal) per calendar day. Falls back to BMR when absent.
  const energyByDay = new Map<string, number>();
  for (const r of whoopEnergy) {
    if (r.energyKcal != null && r.energyKcal > 0) {
      energyByDay.set(zonedDayKeyFromDate(r.date, tz), r.energyKcal);
    }
  }

  /**
   * BMR via Mifflin–St Jeor. Needs height + DOB + sex on the profile and a
   * per-day weight (forward-filled from WHOOP + manual scale logs). Used as the
   * burn fallback on days without a WHOOP energy reading.
   */
  const heightCm = profile?.heightCm ?? null;
  const dob = profile?.dateOfBirth ?? null;
  const sex: BiologicalSex | null =
    profile?.biologicalSex === "MALE" ||
    profile?.biologicalSex === "FEMALE" ||
    profile?.biologicalSex === "OTHER"
      ? (profile.biologicalSex as BiologicalSex)
      : null;

  const windowStartMs = projectionStart.getTime();
  const tpNow = localCalendarParts(now, tz);
  const todayStartMs = startOfZonedCalendarDay(tpNow.y, tpNow.m, tpNow.d, tz).getTime();

  const weightHistory: { date: Date; weightKg: number }[] = [];
  for (const w of weightWhoop) {
    if (w.weightKg != null) weightHistory.push({ date: w.date, weightKg: w.weightKg });
  }
  for (const w of weightManual) {
    weightHistory.push({ date: w.date, weightKg: w.weightKg });
  }
  weightHistory.sort((a, b) => a.date.getTime() - b.date.getTime());

  const weightByDayMs = buildPerDayWeightKg({
    history: weightHistory,
    startDayMs: windowStartMs,
    endDayMs: todayStartMs,
    dayStartMs: (d) => canonicalZonedDayStart(d, tz).getTime(),
    advanceCalendarDayMs: (ms) => nextZonedCalendarDayStartMs(ms, tz),
  });

  const hasProfile = heightCm != null && dob != null && sex != null;
  const hasWeight = weightByDayMs.size > 0;
  const hasWhoopEnergy = energyByDay.size > 0;
  // Burn is computable if we have WHOOP energy OR can fall back to BMR.
  const burnReady = hasWhoopEnergy || (hasProfile && hasWeight);

  /**
   * Per-day energy series. Total burn = WHOOP full-day energy when available,
   * else BMR (which tracks weight). Deficit = consumed − burn.
   */
  type EnergyPoint = {
    day: string;
    consumedKcal: number | null;
    bmrKcal: number | null;
    totalBurnKcal: number | null;
    deficitKcal: number | null;
  };
  const energySeries: EnergyPoint[] = [];
  for (const d of mergedTrusted) {
    const dayMs = canonicalZonedDayStart(d.date, tz).getTime();
    const weight = weightByDayMs.get(dayMs) ?? null;
    const ageY = dob ? ageYearsAt(dob, d.date) : null;
    const bmr =
      hasProfile && weight != null && ageY != null
        ? mifflinStJeorBmrKcal({
            weightKg: weight,
            heightCm: heightCm!,
            ageYears: ageY,
            sex: sex!,
          })
        : null;
    const whoopBurn = energyByDay.get(d.dayKey) ?? null;
    const totalBurn = whoopBurn != null ? whoopBurn : bmr;
    const consumed = d.caloriesKcal;
    const deficit = totalBurn != null ? consumed - totalBurn : null;

    energySeries.push({
      day: dayLabel(d.date, tz),
      consumedKcal: Math.round(consumed),
      bmrKcal: bmr != null ? Math.round(bmr) : null,
      totalBurnKcal: totalBurn != null ? Math.round(totalBurn) : null,
      deficitKcal: deficit != null ? Math.round(deficit) : null,
    });
  }

  const avgFromSeries = (key: keyof EnergyPoint) => {
    let sum = 0;
    let n = 0;
    for (const p of energySeries) {
      const v = p[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    return n > 0 ? sum / n : null;
  };
  const avgBurn = avgFromSeries("totalBurnKcal");
  const avgDeficit = avgFromSeries("deficitKcal");

  const macrosData = mergedTrusted.map((d) => ({
    day: dayLabel(d.date, tz),
    protein: Math.round(d.proteinG),
    carbs: Math.round(d.carbsG),
    fat: Math.round(d.fatG),
  }));

  const deficitDescription = burnReady
    ? "WHOOP full-day energy burn (fallback Mifflin–St Jeor BMR). Negative bars = deficit, positive = surplus."
    : "Connect WHOOP for daily energy burn, or add height, DOB and biological sex (+ a weight) to fall back to BMR.";

  return (
    <>
      <ProfileCard
        profile={{
          heightCm,
          dateOfBirth: dob,
          biologicalSex: sex,
        }}
        burnReady={burnReady}
        hasWeight={hasWeight}
      />

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Calories (avg)"
          value={avgCalories != null ? `${Math.round(avgCalories)} kcal` : "—"}
          hint={trustedHint}
        />
        <StatCard
          title="Calories burned (avg)"
          value={avgBurn != null ? `${Math.round(avgBurn)} kcal` : "—"}
          hint={
            burnReady
              ? `WHOOP energy (fallback BMR) · ${trustedHint}`
              : "Connect WHOOP or complete BMR profile"
          }
        />
        <StatCard
          title="Deficit (avg)"
          value={
            avgDeficit != null
              ? `${avgDeficit >= 0 ? "+" : ""}${Math.round(avgDeficit)} kcal`
              : "—"
          }
          hint={
            avgDeficit != null
              ? avgDeficit < 0
                ? `In a calorie deficit · ${trustedHint}`
                : `In a calorie surplus · ${trustedHint}`
              : "Need consumed + burn on trusted intake days"
          }
        />
        <StatCard
          title="Protein (avg)"
          value={avgProtein != null ? `${Math.round(avgProtein)} g` : "—"}
          hint={trustedHint}
        />
        <StatCard
          title="Carbs (avg)"
          value={avgCarbs != null ? `${Math.round(avgCarbs)} g` : "—"}
          hint={trustedHint}
        />
        <StatCard
          title="Fat (avg)"
          value={avgFat != null ? `${Math.round(avgFat)} g` : "—"}
          hint={trustedHint}
        />
      </section>

      <section>
        <ChartCard
          title="Calories in vs out"
          description={`Consumed (logged food) vs WHOOP full-day burn · ${trustedHint}`}
        >
          <MultiLineChartView
            data={energySeries}
            xKey="day"
            lines={[
              {
                dataKey: "consumedKcal",
                color: chartPalette.amazon,
                name: "Consumed (kcal)",
                yAxisId: "left",
              },
              {
                dataKey: "totalBurnKcal",
                color: chartPalette.adobe,
                name: "Total burn (kcal)",
                yAxisId: "left",
              },
              {
                dataKey: "bmrKcal",
                color: chartPalette.un,
                name: "BMR",
                yAxisId: "left",
                strokeDasharray: "4 4",
                showDots: false,
              },
            ]}
            yDomain={[0, "dataMax"]}
            height={300}
          />
        </ChartCard>
      </section>

      <section>
        <ChartCard
          title="Daily deficit"
          description={`${deficitDescription} Charts include only ${trustedHint.toLowerCase()}.`}
        >
          <MultiLineChartView
            data={energySeries}
            xKey="day"
            lines={[
              {
                dataKey: "deficitKcal",
                color: chartPalette.gia,
                name: "Deficit (kcal)",
                yAxisId: "left",
              },
            ]}
            yDomain={["dataMin", "dataMax"]}
            referenceLines={[
              {
                x: energySeries[0]?.day ?? "",
                color: "color-mix(in srgb, var(--color-text-tertiary) 25%, transparent)",
              },
            ]}
            height={240}
          />
        </ChartCard>
      </section>

      <section>
        <ChartCard
          title="Macros"
          description={`Daily protein / carbs / fat (g) · ${trustedHint.toLowerCase()}`}
        >
          <MultiLineChartView
            data={macrosData}
            xKey="day"
            lines={[
              {
                dataKey: "protein",
                color: chartPalette.un,
                name: "Protein (g)",
                yAxisId: "left",
              },
              {
                dataKey: "carbs",
                color: chartPalette.cal,
                name: "Carbs (g)",
                yAxisId: "left",
              },
              {
                dataKey: "fat",
                color: chartPalette.gia,
                name: "Fat (g)",
                yAxisId: "left",
              },
            ]}
            yDomain={[0, "dataMax"]}
            height={260}
          />
        </ChartCard>
      </section>
    </>
  );
}

function ProfileCard({
  profile,
  burnReady,
  hasWeight,
}: {
  profile: {
    heightCm: number | null;
    dateOfBirth: Date | null;
    biologicalSex: BiologicalSex | null;
  };
  burnReady: boolean;
  hasWeight: boolean;
}) {
  const heightInches =
    profile.heightCm != null
      ? Math.round((profile.heightCm / 2.54) * 10) / 10
      : null;
  const dobIso = profile.dateOfBirth
    ? profile.dateOfBirth.toISOString().slice(0, 10)
    : "";

  return (
    <details
      open={!burnReady}
      className="rounded-2xl border border-[color:var(--color-border-subtle)] bg-card/80 p-5 shadow-sm"
    >
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 list-none">
        <div>
          <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">
            BMR profile
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
            {burnReady
              ? `${profile.heightCm != null ? `${profile.heightCm.toFixed(0)} cm · ` : ""}${profile.biologicalSex ?? ""}${dobIso ? ` · DOB ${dobIso}` : ""}`
              : !hasWeight
                ? "Log a weight to enable the BMR burn fallback."
                : "Add height, DOB and biological sex to compute BMR."}
          </p>
        </div>
        <span className="text-xs font-medium text-orange-700 underline-offset-2 group-open:hidden">
          Edit
        </span>
      </summary>

      <form
        action="/api/nutrition/profile"
        method="post"
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="block">
          <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
            Height
          </div>
          <div className="mt-1 flex gap-2">
            <input
              name="height"
              type="number"
              step="0.1"
              min="50"
              max="260"
              placeholder="e.g. 178"
              defaultValue={profile.heightCm ?? ""}
              className="h-10 flex-1 rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
            />
            <select
              name="heightUnit"
              defaultValue="cm"
              className="h-10 rounded-xl border border-amber-950/15 bg-card px-2 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
            >
              <option value="cm">cm</option>
              <option value="in">in</option>
            </select>
          </div>
          {heightInches != null ? (
            <p className="mt-1 text-[11px] text-stone-500">
              ≈ {heightInches.toFixed(1)} in
            </p>
          ) : null}
        </label>

        <label className="block">
          <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
            Date of birth
          </div>
          <input
            name="dateOfBirth"
            type="date"
            defaultValue={dobIso}
            className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
          />
        </label>

        <label className="block">
          <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
            Biological sex
          </div>
          <select
            name="biologicalSex"
            defaultValue={profile.biologicalSex ?? ""}
            className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
          >
            <option value="">Not set</option>
            <option value="MALE">Male</option>
            <option value="FEMALE">Female</option>
            <option value="OTHER">Other</option>
          </select>
          <p className="mt-1 text-[11px] text-stone-500">
            Used by Mifflin–St Jeor.
          </p>
        </label>

        <div className="flex items-end">
          <button className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
            Save profile
          </button>
        </div>
      </form>
    </details>
  );
}
