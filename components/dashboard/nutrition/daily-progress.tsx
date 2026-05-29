import "server-only";

import { prisma } from "@/lib/db";
import { parseIsoDateOnlyInTz, localCalendarParts } from "@/lib/zoned-calendar";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import type { MacroTargets } from "@/lib/nutrition-goal";

/**
 * Today's intake progress: 4 bars (kcal + protein + carbs + fat) against the
 * user's targets. Renders inside WeightGoalCard.
 *
 * Over-target visual (DESIGN-2): the bar fills past 100% in **amber** (not
 * red), with "+N over" copy and a one-line nudge underneath. Treats over-
 * eating as data, not failure.
 *
 * Data source: SUM of today's FoodLogEntry rows — the single intake source.
 */
export async function DailyProgress({
  userId,
  intakeKcal,
  macroTargets,
}: {
  userId: string;
  intakeKcal: number;
  macroTargets: MacroTargets;
}) {
  const userRow = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userRow?.timezone);

  // Today in user TZ → UTC midnight on that calendar day (matches the
  // convention FoodLogEntry.date uses).
  const tp = localCalendarParts(new Date(), tz);
  const todayIso = `${tp.y}-${String(tp.m).padStart(2, "0")}-${String(tp.d).padStart(2, "0")}`;
  const dateOk = parseIsoDateOnlyInTz(todayIso, tz);
  const todayStart = dateOk?.date ?? null;

  let kcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  if (todayStart) {
    const agg = await prisma().foodLogEntry.aggregate({
      where: { userId, date: todayStart },
      _sum: { caloriesKcal: true, proteinG: true, carbsG: true, fatG: true },
    });
    kcal = agg._sum.caloriesKcal ?? 0;
    proteinG = agg._sum.proteinG ?? 0;
    carbsG = agg._sum.carbsG ?? 0;
    fatG = agg._sum.fatG ?? 0;
  }

  const bars = [
    { key: "kcal", label: "Calories", unit: "kcal", consumed: kcal, target: intakeKcal },
    { key: "protein", label: "Protein", unit: "g", consumed: proteinG, target: macroTargets.proteinG },
    { key: "carbs", label: "Carbs", unit: "g", consumed: carbsG, target: macroTargets.carbsG },
    { key: "fat", label: "Fat", unit: "g", consumed: fatG, target: macroTargets.fatG },
  ];

  const allZero = bars.every((b) => b.consumed === 0);

  return (
    <div className="space-y-3" role="region" aria-label="Today's intake progress">
      {bars.map(({ key, ...rest }) => (
        <ProgressBar key={key} {...rest} />
      ))}
      {allZero ? (
        <p className="mt-1 text-xs text-stone-600">
          Log your first food today → search below.
        </p>
      ) : null}
    </div>
  );
}

function fmt(n: number, digits = 0) {
  if (digits === 0) return Math.round(n).toLocaleString();
  return (Math.round(n * 10) / 10).toLocaleString();
}

function ProgressBar({
  label,
  unit,
  consumed,
  target,
}: {
  label: string;
  unit: string;
  consumed: number;
  target: number;
}) {
  const pct = target > 0 ? (consumed / target) * 100 : 0;
  const over = consumed > target && target > 0;
  const remaining = Math.round(target - consumed);
  const color = over ? "#d97706" /* amber-600 */ : "var(--ui-accent)";
  // Clamp the visible fill at 100% (the +N copy carries the over-target signal).
  const fillPct = Math.min(100, Math.max(0, pct));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-stone-700">{label}</span>
        <span className="text-[11px] tabular-nums text-stone-600">
          {fmt(consumed)} / {fmt(target)} {unit}
          {over ? (
            <span className="ml-2 font-medium text-amber-700">
              +{Math.abs(remaining)} over
            </span>
          ) : remaining > 0 ? (
            <span className="ml-2 text-stone-500">
              {remaining} left
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-border-subtle)]">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${fillPct}%`,
            backgroundColor: color,
          }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(target)}
          aria-valuenow={Math.round(consumed)}
          aria-valuetext={`${fmt(consumed)} of ${fmt(target)} ${unit}, ${
            over
              ? `${Math.abs(remaining)} over`
              : `${remaining} ${unit} remaining`
          }`}
        />
      </div>
      {over ? (
        <p className="mt-1 text-[10px] leading-snug text-stone-500">
          Over target by {Math.abs(remaining)} — dial back tomorrow or add a walk.
        </p>
      ) : null}
    </div>
  );
}
