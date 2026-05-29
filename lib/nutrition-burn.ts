/**
 * BMR + total energy burn helpers for the Nutrition page.
 *
 * Resting metabolic rate is estimated with the **Mifflin–St Jeor** equation,
 * which is the formula used by major sports-nutrition references (and
 * MyFitnessPal). It needs weight (kg), height (cm), age (years) and sex; for
 * `OTHER` we average the male/female sex constants. We deliberately avoid
 * Katch-McArdle (needs body fat %) and Harris-Benedict (older / less accurate).
 */

export type BiologicalSex = "MALE" | "FEMALE" | "OTHER";

/** Years between two dates, floored. Matches what users intuitively expect. */
export function ageYearsAt(dob: Date, on: Date): number {
  let years = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) years -= 1;
  return Math.max(0, years);
}

/**
 * Mifflin–St Jeor BMR (kcal / day). Returns null for nonsensical inputs.
 *
 * Male:   10·kg + 6.25·cm − 5·age + 5
 * Female: 10·kg + 6.25·cm − 5·age − 161
 * Other:  average of the two sex constants (yields the midpoint).
 */
export function mifflinStJeorBmrKcal(args: {
  weightKg: number;
  heightCm: number;
  ageYears: number;
  sex: BiologicalSex;
}): number | null {
  const { weightKg, heightCm, ageYears, sex } = args;
  if (
    !Number.isFinite(weightKg) ||
    !Number.isFinite(heightCm) ||
    !Number.isFinite(ageYears) ||
    weightKg <= 0 ||
    heightCm <= 0 ||
    ageYears < 0
  ) {
    return null;
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  const sexConstant = sex === "MALE" ? 5 : sex === "FEMALE" ? -161 : -78;
  return base + sexConstant;
}

/**
 * Forward-fill a sparse weight history (kg) to a per-day map for every day in
 * `[startMs, endMs]` (inclusive on both ends, midnight-aligned). Each day uses
 * the most recent prior weight measurement; days before the first measurement
 * stay null.
 *
 * Caller passes `dayStartMs(date)` (typically zoned-calendar midnight) so the
 * grouping matches whatever the chart axis uses.
 */
export function buildPerDayWeightKg(args: {
  history: { date: Date; weightKg: number }[];
  startDayMs: number;
  endDayMs: number;
  dayStartMs: (d: Date) => number;
  advanceCalendarDayMs: (ms: number) => number;
}): Map<number, number> {
  const out = new Map<number, number>();
  const sorted = args.history
    .filter((h) => Number.isFinite(h.weightKg) && h.weightKg > 0)
    .map((h) => ({ ms: args.dayStartMs(h.date), kg: h.weightKg }))
    .sort((a, b) => a.ms - b.ms);

  let i = 0;
  let lastKg: number | null = null;
  let cur = args.startDayMs;
  let safety = 0;
  while (cur <= args.endDayMs && safety < 4000) {
    while (i < sorted.length && sorted[i].ms <= cur) {
      lastKg = sorted[i].kg;
      i += 1;
    }
    if (lastKg != null) out.set(cur, lastKg);
    cur = args.advanceCalendarDayMs(cur);
    safety += 1;
  }
  return out;
}
