import "server-only";

import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import { localCalendarParts } from "@/lib/zoned-calendar";
import {
  isoWeek,
  latestIntakeKcal,
  recalibrateWeeklyIntake,
  LB_PER_KG,
  MIN_WEEKS_TO_DEADLINE,
  type IntakeHistoryEntry,
  type WeighIn,
} from "@/lib/nutrition-goal";

/**
 * Server-side orchestrator for the closed-loop weekly recalibration. Gathers
 * last week's weigh-ins (manual + WHOOP, manual wins per day) and the average
 * daily MANUAL intake, hands them to the pure `recalibrateWeeklyIntake`, and
 * persists the result onto the active WeightGoal.
 *
 * Idempotency (ARCH-1): auto-runs are gated on `lastRecalibratedIsoWeek`. The
 * manual "Recompute" button passes `{ manual: true }` to bypass the guard.
 * A skip (too few weigh-ins) deliberately does NOT bump the week marker, so a
 * later load the same week can retry once more weigh-ins land.
 */

/** Window we look back over to measure loss + average intake. */
const LOOKBACK_DAYS = 8;

export type RecalibrationOutcome =
  | { status: "no_goal" }
  | { status: "already_done"; isoWeek: string }
  | {
      status: "skipped";
      reason: "insufficient_weigh_ins" | "no_intake_logged";
      weighInCount: number;
      currentIntakeKcal: number;
    }
  | {
      status: "recalibrated";
      previousIntakeKcal: number;
      newIntakeKcal: number;
      deltaKcal: number;
      direction: "increase" | "decrease" | "unchanged";
      isoWeek: string;
    };

/** UTC-midnight day key (ms) for a date — matches the FoodLogEntry.date convention. */
function dayKeyMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function runWeeklyRecalibration(
  userId: string,
  opts: { manual: boolean },
): Promise<RecalibrationOutcome> {
  const goal = await prisma().weightGoal.findFirst({
    where: { userId, isActive: true },
    select: {
      id: true,
      deadlineDate: true,
      targetWeightLb: true,
      intakeHistory: true,
      lastRecalibratedIsoWeek: true,
    },
  });
  if (!goal) return { status: "no_goal" };

  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(user?.timezone);
  const now = new Date();

  // ISO week computed against the user's calendar day, not the server's, so the
  // weekly boundary lands where the user expects.
  const tp = localCalendarParts(now, tz);
  const zonedToday = new Date(Date.UTC(tp.y, tp.m - 1, tp.d));
  const currentWeek = isoWeek(zonedToday);

  const history = goal.intakeHistory as unknown as IntakeHistoryEntry[];
  const currentIntakeKcal = latestIntakeKcal(history) ?? 0;

  if (!opts.manual && goal.lastRecalibratedIsoWeek === currentWeek) {
    return { status: "already_done", isoWeek: currentWeek };
  }

  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const [manualWeights, whoopWeights, foodByDay] = await Promise.all([
    prisma().manualWeightLog.findMany({
      where: { userId, date: { gte: since } },
      select: { date: true, weightKg: true },
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, weightKg: { not: null }, date: { gte: since } },
      select: { date: true, weightKg: true },
    }),
    prisma().foodLogEntry.groupBy({
      by: ["date"],
      where: { userId, date: { gte: since } },
      _sum: { caloriesKcal: true },
    }),
  ]);

  // One weigh-in per calendar day; manual overrides WHOOP on the same day.
  const byDay = new Map<number, WeighIn>();
  for (const w of whoopWeights) {
    if (w.weightKg == null) continue;
    byDay.set(dayKeyMs(w.date), { date: w.date, weightLb: w.weightKg * LB_PER_KG });
  }
  for (const w of manualWeights) {
    byDay.set(dayKeyMs(w.date), { date: w.date, weightLb: w.weightKg * LB_PER_KG });
  }
  const weighIns = [...byDay.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  // Average daily MANUAL intake over the days that actually have logged food.
  const dayTotals = foodByDay
    .map((r) => r._sum.caloriesKcal ?? 0)
    .filter((kcal) => kcal > 0);
  if (dayTotals.length === 0) {
    return {
      status: "skipped",
      reason: "no_intake_logged",
      weighInCount: weighIns.length,
      currentIntakeKcal,
    };
  }
  const avgDailyIntakeKcal =
    dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length;

  // Latest weight anchors the re-derived deficit; weeks-left shrinks over time.
  const currentWeightLb =
    weighIns.length > 0 ? weighIns[weighIns.length - 1].weightLb : 0;
  const daysToDeadline = Math.max(
    0,
    Math.round((goal.deadlineDate.getTime() - zonedToday.getTime()) / 86_400_000),
  );
  const weeksToDeadline = Math.max(MIN_WEEKS_TO_DEADLINE, daysToDeadline / 7);

  const result = recalibrateWeeklyIntake({
    currentIntakeKcal,
    weighInsLb: weighIns,
    avgDailyIntakeKcal,
    currentWeightLb,
    targetWeightLb: goal.targetWeightLb,
    weeksToDeadline,
  });

  if (result.status === "skipped") {
    // Do NOT mark the week — let a later load retry as more weigh-ins arrive.
    return {
      status: "skipped",
      reason: "insufficient_weigh_ins",
      weighInCount: result.weighInCount,
      currentIntakeKcal,
    };
  }

  // Recalibration ran. Always mark the week (idempotency). Only append a
  // history entry when the target actually moved — avoids cluttering the log
  // with no-op rows on weeks the user is dead on pace.
  const data: Prisma.WeightGoalUpdateInput = {
    lastRecalibratedIsoWeek: currentWeek,
  };
  if (result.deltaKcal !== 0) {
    const entry: IntakeHistoryEntry = {
      weekStartIso: currentWeek,
      intakeKcal: result.newIntakeKcal,
      reason: opts.manual ? "manual" : "recalibrated",
      deltaFromPrev: result.deltaKcal,
    };
    data.intakeHistory = [
      ...history,
      entry,
    ] as unknown as Prisma.InputJsonValue;
  }
  await prisma().weightGoal.update({ where: { id: goal.id }, data });

  return {
    status: "recalibrated",
    previousIntakeKcal: result.previousIntakeKcal,
    newIntakeKcal: result.newIntakeKcal,
    deltaKcal: result.deltaKcal,
    direction: result.direction,
    isoWeek: currentWeek,
  };
}
