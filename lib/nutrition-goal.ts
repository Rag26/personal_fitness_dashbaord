/**
 * Weight-goal math. Pure functions, no Prisma — testable in isolation.
 *
 * Three operations:
 *   computeInitialIntakeTarget — given a goal, derive Day-1 kcal target.
 *   deriveMacroTargets         — given current weight + intake, split into P/C/F
 *                                (with optional per-macro overrides).
 *   paceGuard                  — validate the goal is in a safe weekly-loss band.
 *
 * Future (Phase 2): recalibrateWeeklyIntake — closed-loop adjustment based on
 * actual vs target weight change. Stub exported here so tests can fail loudly
 * if it's used before implementation.
 *
 * Constants:
 *   KCAL_PER_LB_FAT       — the classic "3500 kcal = 1 lb of fat" rule.
 *                           Approximation; actual is closer to 3500–3700 depending
 *                           on body composition. Fine for a personal weight-loss
 *                           target; the closed loop self-corrects either way.
 *   SEDENTARY_MULTIPLIER  — TDEE = BMR × 1.4 fallback when we have no WHOOP
 *                           daily energy-burn data to read from yet.
 *                           Will self-correct in week 1 via recalibration.
 *   MIN_WEEKS_TO_DEADLINE — clamp to avoid divide-by-zero / pace-impossible math.
 *   PROTEIN_G_PER_LB      — 0.9 g/lb body weight (preservation in deficit).
 *   FAT_G_PER_LB          — 0.35 g/lb body weight (hormonal floor).
 *   SAFETY_FLOOR_PCT_BMR  — 0.80 of BMR; below this we warn (don't block).
 *   PACE_*_LB_PER_WK      — the pace-guard "safe band" boundaries.
 */

import { mifflinStJeorBmrKcal, type BiologicalSex } from "@/lib/nutrition-burn";

export const KCAL_PER_LB_FAT = 3500;
export const SEDENTARY_MULTIPLIER = 1.4;
export const MIN_WEEKS_TO_DEADLINE = 1;
export const PROTEIN_G_PER_LB = 0.9;
export const FAT_G_PER_LB = 0.35;
export const SAFETY_FLOOR_PCT_BMR = 0.8;
export const PACE_MIN_SAFE_LB_PER_WK = 0.5;
export const PACE_MAX_SAFE_LB_PER_WK = 2.0;
export const PACE_TOO_SLOW_LB_PER_WK = 0.3;

/** Closed-loop recalibration tunables. */
export const RECAL_MIN_WEIGH_INS = 5; // need 5+ weigh-ins in the window to trust the signal
export const RECAL_MAX_DELTA_KCAL = 200; // damp weekly adjustments to ±200 to avoid water-weight whiplash
export const RECAL_MOVING_AVG_WINDOW = 3; // avg first-3 / last-3 weigh-ins to smooth daily noise

/** Macro periodization tunables (E3). */
export const STRAIN_HIGH_THRESHOLD = 14; // WHOOP strain above this = training day
export const STRAIN_LOW_THRESHOLD = 10; // WHOOP strain below this = rest day
export const PERIODIZATION_CARB_SHIFT_G = 30; // carbs ±30g on shift days
export const PERIODIZATION_FAT_SHIFT_G = 10; // fat ∓10g (kcal-roughly-neutral)

export const KG_PER_LB = 0.45359237;
export const LB_PER_KG = 2.2046226218;

export type PaceWarning =
  | { kind: "too_aggressive"; requiredLbPerWk: number; suggestedExtendDeadline: Date; suggestedRaiseTargetLb: number }
  | { kind: "too_slow"; requiredLbPerWk: number }
  | { kind: "deadline_past_or_today" };

export type InitialIntakeResult = {
  intakeKcal: number;
  bmrKcal: number;
  estimatedMaintenanceKcal: number;
  requiredDailyDeficitKcal: number;
  requiredWeeklyLossLb: number;
  weeksToDeadline: number;
  warnings: {
    pace: PaceWarning | null;
    /** Fires when intake target lands below 0.8 × BMR (still saved, just warned). */
    belowSafetyFloor: boolean;
  };
};

export type MacroTargets = {
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export type MacroOverrides = Partial<MacroTargets>;

/** ISO calendar week computation (UTC). E.g. "2026-W21". */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO 8601: Thursday in current week decides the year.
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** UTC-midnight whole-day count between two dates (positive if `to > from`). */
function wholeDaysBetween(from: Date, to: Date): number {
  const f = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const t = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((t - f) / 86400000);
}

function roundTo25(n: number): number {
  return Math.round(n / 25) * 25;
}

/**
 * Validate that `deadline` is at least one day in the future. We can't compute
 * a sensible intake target if the goal has already passed.
 */
function deadlineIsPastOrToday(today: Date, deadline: Date): boolean {
  return wholeDaysBetween(today, deadline) < 1;
}

/**
 * Run the pace guard for an aspirational goal. Returns a warning when the
 * implied weekly loss falls outside the 0.5–2.0 lb/wk safe band. Caller
 * decides whether to block — by default the form saves the goal anyway,
 * just surfaces the warning.
 */
export function paceGuard(args: {
  today: Date;
  deadline: Date;
  currentWeightLb: number;
  targetWeightLb: number;
}): PaceWarning | null {
  const { today, deadline, currentWeightLb, targetWeightLb } = args;
  if (deadlineIsPastOrToday(today, deadline)) {
    return { kind: "deadline_past_or_today" };
  }
  const daysToDeadline = wholeDaysBetween(today, deadline);
  const weeksToDeadline = Math.max(MIN_WEEKS_TO_DEADLINE, daysToDeadline / 7);
  const totalLbsToLose = currentWeightLb - targetWeightLb;
  const required = totalLbsToLose / weeksToDeadline;

  if (required > PACE_MAX_SAFE_LB_PER_WK) {
    // Suggest the date that would make this a 1.5 lb/wk loss (mid-band).
    const idealRateLbWk = 1.5;
    const idealWeeks = totalLbsToLose / idealRateLbWk;
    const suggestedExtendDeadline = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
        Math.ceil(idealWeeks * 7) * 86400000,
    );
    // Suggest the target that would make THIS deadline a 1.5 lb/wk loss.
    const suggestedRaiseTargetLb =
      Math.round((currentWeightLb - idealRateLbWk * weeksToDeadline) * 10) / 10;
    return {
      kind: "too_aggressive",
      requiredLbPerWk: required,
      suggestedExtendDeadline,
      suggestedRaiseTargetLb,
    };
  }
  if (required > 0 && required < PACE_TOO_SLOW_LB_PER_WK) {
    return { kind: "too_slow", requiredLbPerWk: required };
  }
  return null;
}

/**
 * Day-1 intake target. Combines: required deficit from goal pace + a maintenance
 * (TDEE) estimate.
 *
 * Returns `null` only when BMR can't be computed (missing height / DOB / sex
 * on the User profile) — the API route turns that into a "fill in your profile
 * first" error and asks the user to go to /settings.
 *
 * `maintenanceKcalOverride` is the 30-day average of WHOOP full-day energy burn
 * (cycle kilojoule → kcal). WHOOP's figure is already a full-day TDEE (includes
 * resting), so it's used DIRECTLY as maintenance. When null (no WHOOP data yet),
 * falls back to a sedentary `BMR × 1.4` estimate; the closed-loop recalibration
 * self-corrects in week 1 once weigh-in data lands. BMR is still computed for
 * the safety floor regardless.
 */
export function computeInitialIntakeTarget(args: {
  today: Date;
  deadline: Date;
  currentWeightLb: number;
  targetWeightLb: number;
  heightCm: number;
  ageYears: number;
  sex: BiologicalSex;
  /** 30-day avg WHOOP daily energy burn (kcal, full-day TDEE). Null if no data. */
  maintenanceKcalOverride: number | null;
}): InitialIntakeResult | null {
  const {
    today,
    deadline,
    currentWeightLb,
    targetWeightLb,
    heightCm,
    ageYears,
    sex,
    maintenanceKcalOverride,
  } = args;

  const bmrKcal = mifflinStJeorBmrKcal({
    weightKg: currentWeightLb * KG_PER_LB,
    heightCm,
    ageYears,
    sex,
  });
  if (bmrKcal == null) return null;

  const pace = paceGuard({ today, deadline, currentWeightLb, targetWeightLb });
  // Refuse goals with deadlines in the past — the page route turns this into
  // a form error rather than calling this function.
  if (pace?.kind === "deadline_past_or_today") {
    return {
      intakeKcal: 0,
      bmrKcal,
      estimatedMaintenanceKcal: 0,
      requiredDailyDeficitKcal: 0,
      requiredWeeklyLossLb: 0,
      weeksToDeadline: 0,
      warnings: { pace, belowSafetyFloor: false },
    };
  }

  const daysToDeadline = wholeDaysBetween(today, deadline);
  const weeksToDeadline = Math.max(MIN_WEEKS_TO_DEADLINE, daysToDeadline / 7);
  const totalLbsToLose = currentWeightLb - targetWeightLb;
  const requiredWeeklyLossLb = totalLbsToLose / weeksToDeadline;
  const requiredDailyDeficitKcal = (requiredWeeklyLossLb * KCAL_PER_LB_FAT) / 7;

  // WHOOP daily burn is already a full-day TDEE, so use it as-is when present.
  const estimatedMaintenanceKcal =
    maintenanceKcalOverride != null &&
    Number.isFinite(maintenanceKcalOverride) &&
    maintenanceKcalOverride > 0
      ? maintenanceKcalOverride
      : bmrKcal * SEDENTARY_MULTIPLIER;

  const rawIntake = estimatedMaintenanceKcal - requiredDailyDeficitKcal;
  const intakeKcal = roundTo25(rawIntake);
  const belowSafetyFloor = intakeKcal < bmrKcal * SAFETY_FLOOR_PCT_BMR;

  return {
    intakeKcal,
    bmrKcal: Math.round(bmrKcal),
    estimatedMaintenanceKcal: Math.round(estimatedMaintenanceKcal),
    requiredDailyDeficitKcal: Math.round(requiredDailyDeficitKcal),
    requiredWeeklyLossLb,
    weeksToDeadline,
    warnings: { pace, belowSafetyFloor },
  };
}

/**
 * Macro targets derived from current weight + intake kcal. Default split:
 *   protein = 0.9 g/lb body weight
 *   fat     = 0.35 g/lb body weight
 *   carbs   = (intake − protein·4 − fat·9) / 4
 *
 * User overrides win absolutely — any field set on `overrides` is used verbatim;
 * the remaining (non-overridden) fields are derived to balance the kcal budget.
 *
 * Returns null when the override combo makes the remaining kcal budget negative
 * (impossible target — UI surfaces an error and asks the user to relax an override).
 */
export function deriveMacroTargets(args: {
  currentWeightLb: number;
  intakeKcal: number;
  overrides?: MacroOverrides | null;
}): MacroTargets | { error: "impossible_combo" } {
  const { currentWeightLb, intakeKcal, overrides } = args;
  const ovr: MacroOverrides = overrides ?? {};

  const proteinG =
    ovr.proteinG != null && Number.isFinite(ovr.proteinG) && ovr.proteinG >= 0
      ? ovr.proteinG
      : Math.round(currentWeightLb * PROTEIN_G_PER_LB);
  const fatG =
    ovr.fatG != null && Number.isFinite(ovr.fatG) && ovr.fatG >= 0
      ? ovr.fatG
      : Math.round(currentWeightLb * FAT_G_PER_LB);
  const proteinKcal = proteinG * 4;
  const fatKcal = fatG * 9;

  let carbsG: number;
  if (ovr.carbsG != null && Number.isFinite(ovr.carbsG) && ovr.carbsG >= 0) {
    carbsG = ovr.carbsG;
  } else {
    const remainingKcal = intakeKcal - proteinKcal - fatKcal;
    if (remainingKcal < 0) {
      return { error: "impossible_combo" };
    }
    carbsG = Math.round(remainingKcal / 4);
  }

  return { proteinG: Math.round(proteinG), carbsG, fatG: Math.round(fatG) };
}

/**
 * Currently-active intake target from a WeightGoal's intakeHistory array.
 * The last element wins; if the array is empty (shouldn't happen — the goal
 * is always created with an initial entry), returns null.
 */
export type IntakeHistoryEntry = {
  weekStartIso: string;
  intakeKcal: number;
  reason: "initial" | "recalibrated" | "manual";
  deltaFromPrev: number;
};

export function latestIntakeKcal(history: IntakeHistoryEntry[]): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  return typeof last.intakeKcal === "number" ? last.intakeKcal : null;
}

/** A single weigh-in inside the recalibration window. */
export type WeighIn = { date: Date; weightLb: number };

export type RecalibrationResult =
  | {
      status: "skipped";
      reason: "insufficient_weigh_ins";
      weighInCount: number;
      currentIntakeKcal: number;
    }
  | {
      status: "recalibrated";
      previousIntakeKcal: number;
      newIntakeKcal: number;
      /** Clamped delta actually applied (newIntake − previousIntake). */
      deltaKcal: number;
      direction: "increase" | "decrease" | "unchanged";
      /** Smoothed observed loss over the window (start-avg − end-avg), lbs. */
      actualLossLb: number;
      /** What we were aiming to lose over the same ~1-week window, lbs. */
      targetWeeklyLossLb: number;
      /** Back-computed maintenance from observed loss + logged intake. */
      impliedMaintenanceKcal: number;
    };

/** Mean of an array; 0 for empty (callers guard upstream). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Closed-loop weekly recalibration. THE feature: a static "BMR × activity −
 * deficit" formula drifts because BMR drops as you lose weight and activity
 * self-regulates. This anchors next week's intake on the *observed* weight
 * change instead.
 *
 * Algorithm (matches the plan):
 *   1. Require ≥ RECAL_MIN_WEIGH_INS weigh-ins in the window, else skip
 *      (do NOT bump lastRecalibratedIsoWeek upstream — next load can retry
 *      against a larger window).
 *   2. Smooth daily weight noise: start = avg(first 3), end = avg(last 3).
 *      actual_loss = start − end.
 *   3. implied_maintenance = avg_daily_intake + (actual_loss × 3500 / 7).
 *   4. new_target = implied_maintenance − target_daily_deficit, where
 *      target_daily_deficit is RE-derived from current weight + weeks left
 *      (so the deficit shrinks correctly as the deadline approaches).
 *   5. Damp: clamp(new_target − current_target, ±200), then round to 25.
 *
 * Pure — no Prisma, no clock. `weighInsLb` must be sorted ascending by date.
 */
export function recalibrateWeeklyIntake(args: {
  currentIntakeKcal: number;
  /** Weigh-ins in the lookback window, ascending by date. */
  weighInsLb: WeighIn[];
  /** Average daily MANUAL intake (kcal) over the same ~7-day window. */
  avgDailyIntakeKcal: number;
  /** Latest known weight, for re-deriving the remaining deficit. */
  currentWeightLb: number;
  targetWeightLb: number;
  /** Whole weeks left to the deadline (already clamped ≥ 1 by the caller). */
  weeksToDeadline: number;
}): RecalibrationResult {
  const {
    currentIntakeKcal,
    weighInsLb,
    avgDailyIntakeKcal,
    currentWeightLb,
    targetWeightLb,
    weeksToDeadline,
  } = args;

  const sorted = [...weighInsLb].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  if (sorted.length < RECAL_MIN_WEIGH_INS) {
    return {
      status: "skipped",
      reason: "insufficient_weigh_ins",
      weighInCount: sorted.length,
      currentIntakeKcal,
    };
  }

  const k = RECAL_MOVING_AVG_WINDOW;
  const firstK = sorted.slice(0, k);
  const lastK = sorted.slice(-k);
  const startAvg = mean(firstK.map((w) => w.weightLb));
  const endAvg = mean(lastK.map((w) => w.weightLb));
  const actualLossLb = startAvg - endAvg;

  // Convert the smoothed loss to a per-day rate. The plan's pseudocode divides
  // by a hardcoded 7, but the first-3 / last-3 averages are *centered* — their
  // means sit ~k days inside each end of the window — so the true elapsed span
  // is the gap between those two centroids, not the full window and not 7. Using
  // the real span removes a systematic downward bias (on-track loss would
  // otherwise read as under-target and quietly cut intake every week).
  const startCentroidMs = mean(firstK.map((w) => w.date.getTime()));
  const endCentroidMs = mean(lastK.map((w) => w.date.getTime()));
  const spanDays = Math.max(1, (endCentroidMs - startCentroidMs) / 86_400_000);
  const dailyLossRateLb = actualLossLb / spanDays;

  // Back out maintenance from what actually happened: intake we ate + the
  // energy the observed loss implies we burned beyond it.
  const impliedDailyDeficit = dailyLossRateLb * KCAL_PER_LB_FAT;
  const impliedMaintenanceKcal = avgDailyIntakeKcal + impliedDailyDeficit;

  // Re-derive the deficit we *want* from here, against the latest weight and
  // the (shrinking) time to deadline.
  const weeks = Math.max(MIN_WEEKS_TO_DEADLINE, weeksToDeadline);
  const targetWeeklyLossLb = (currentWeightLb - targetWeightLb) / weeks;
  const targetDailyDeficitKcal = (targetWeeklyLossLb * KCAL_PER_LB_FAT) / 7;

  const rawNewTarget = impliedMaintenanceKcal - targetDailyDeficitKcal;
  const rawDelta = rawNewTarget - currentIntakeKcal;
  const clampedDelta = Math.max(
    -RECAL_MAX_DELTA_KCAL,
    Math.min(RECAL_MAX_DELTA_KCAL, rawDelta),
  );
  const newIntakeKcal = roundTo25(currentIntakeKcal + clampedDelta);
  const deltaKcal = newIntakeKcal - currentIntakeKcal;

  return {
    status: "recalibrated",
    previousIntakeKcal: currentIntakeKcal,
    newIntakeKcal,
    deltaKcal,
    direction: deltaKcal > 0 ? "increase" : deltaKcal < 0 ? "decrease" : "unchanged",
    actualLossLb: Math.round(actualLossLb * 100) / 100,
    targetWeeklyLossLb: Math.round(targetWeeklyLossLb * 100) / 100,
    impliedMaintenanceKcal: Math.round(impliedMaintenanceKcal),
  };
}

/**
 * Training-day macro periodization (E3). Shifts the displayed macro split based
 * on today's WHOOP strain — WITHOUT changing total intake kcal materially.
 *
 *   strain > 14 (training day): carbs +30g, fat −10g
 *   strain < 10 (rest day):     carbs −30g, fat +10g
 *   10 ≤ strain ≤ 14, or strain null/unavailable: unchanged
 *
 * **Override precedence (ARCH-3):** a user override wins absolutely. Any macro
 * present in `overrides` is never periodized. If only one of carbs/fat is
 * overridden, the kcal total may drift by ~±90 on a shift day — a documented
 * limitation; overrides explicitly mean "I want this exact value".
 *
 * Protein is never shifted. `base` should already be the override-respecting
 * output of deriveMacroTargets(). Macros are floored at 0.
 */
export function applyMacroPeriodization(args: {
  base: MacroTargets;
  strain: number | null;
  overrides?: MacroOverrides | null;
}): { macros: MacroTargets; applied: "training" | "rest" | "none" } {
  const { base, strain, overrides } = args;
  const ovr: MacroOverrides = overrides ?? {};
  const carbsOverridden = ovr.carbsG != null && Number.isFinite(ovr.carbsG);
  const fatOverridden = ovr.fatG != null && Number.isFinite(ovr.fatG);

  if (strain == null || !Number.isFinite(strain)) {
    return { macros: { ...base }, applied: "none" };
  }

  let applied: "training" | "rest" | "none" = "none";
  let carbsDelta = 0;
  let fatDelta = 0;

  if (strain > STRAIN_HIGH_THRESHOLD) {
    applied = "training";
    if (!carbsOverridden) carbsDelta = PERIODIZATION_CARB_SHIFT_G;
    if (!fatOverridden) fatDelta = -PERIODIZATION_FAT_SHIFT_G;
  } else if (strain < STRAIN_LOW_THRESHOLD) {
    applied = "rest";
    if (!carbsOverridden) carbsDelta = -PERIODIZATION_CARB_SHIFT_G;
    if (!fatOverridden) fatDelta = PERIODIZATION_FAT_SHIFT_G;
  }

  return {
    macros: {
      proteinG: base.proteinG,
      carbsG: Math.max(0, base.carbsG + carbsDelta),
      fatG: Math.max(0, base.fatG + fatDelta),
    },
    applied,
  };
}
