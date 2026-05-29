import { describe, expect, it } from "vitest";

import {
  applyMacroPeriodization,
  computeInitialIntakeTarget,
  deriveMacroTargets,
  isoWeek,
  latestIntakeKcal,
  paceGuard,
  PACE_MAX_SAFE_LB_PER_WK,
  PACE_TOO_SLOW_LB_PER_WK,
  PERIODIZATION_CARB_SHIFT_G,
  PERIODIZATION_FAT_SHIFT_G,
  RECAL_MAX_DELTA_KCAL,
  recalibrateWeeklyIntake,
  SEDENTARY_MULTIPLIER,
  type WeighIn,
} from "./nutrition-goal";

// Today and deadlines are UTC-midnight dates so day math is deterministic.
const TODAY = new Date("2026-05-24T00:00:00Z");
const D_PLUS = (days: number) =>
  new Date(TODAY.getTime() + days * 86400000);

describe("isoWeek", () => {
  it("formats year-Wxx with zero-padded week", () => {
    expect(isoWeek(new Date("2026-05-24T00:00:00Z"))).toBe("2026-W21");
    expect(isoWeek(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

describe("paceGuard", () => {
  it("returns null when weekly loss is in the safe band", () => {
    // 12 lb in 13 weeks ≈ 0.92 lb/wk — squarely safe.
    expect(
      paceGuard({
        today: TODAY,
        deadline: D_PLUS(13 * 7),
        currentWeightLb: 157,
        targetWeightLb: 145,
      }),
    ).toBeNull();
  });

  it("flags too-aggressive goals (> 2 lb/wk) and suggests alternatives", () => {
    // 30 lb in 10 weeks = 3 lb/wk — too aggressive.
    const res = paceGuard({
      today: TODAY,
      deadline: D_PLUS(70),
      currentWeightLb: 175,
      targetWeightLb: 145,
    });
    expect(res?.kind).toBe("too_aggressive");
    if (res?.kind === "too_aggressive") {
      expect(res.requiredLbPerWk).toBeGreaterThan(PACE_MAX_SAFE_LB_PER_WK);
      expect(res.suggestedExtendDeadline.getTime()).toBeGreaterThan(D_PLUS(70).getTime());
      expect(res.suggestedRaiseTargetLb).toBeGreaterThan(145);
      expect(res.suggestedRaiseTargetLb).toBeLessThan(175);
    }
  });

  it("flags too-slow goals (< 0.3 lb/wk)", () => {
    // 1 lb in 13 weeks ≈ 0.08 lb/wk — slower than weigh-in noise.
    const res = paceGuard({
      today: TODAY,
      deadline: D_PLUS(91),
      currentWeightLb: 146,
      targetWeightLb: 145,
    });
    expect(res?.kind).toBe("too_slow");
    if (res?.kind === "too_slow") {
      expect(res.requiredLbPerWk).toBeLessThan(PACE_TOO_SLOW_LB_PER_WK);
    }
  });

  it("rejects deadlines today or in the past", () => {
    expect(
      paceGuard({
        today: TODAY,
        deadline: TODAY,
        currentWeightLb: 157,
        targetWeightLb: 145,
      })?.kind,
    ).toBe("deadline_past_or_today");
    expect(
      paceGuard({
        today: TODAY,
        deadline: D_PLUS(-1),
        currentWeightLb: 157,
        targetWeightLb: 145,
      })?.kind,
    ).toBe("deadline_past_or_today");
  });
});

describe("computeInitialIntakeTarget", () => {
  const baseProfile = {
    today: TODAY,
    deadline: D_PLUS(13 * 7),
    currentWeightLb: 157,
    targetWeightLb: 145,
    heightCm: 178,
    ageYears: 30,
    sex: "MALE" as const,
  };

  it("computes a sane intake target for a realistic goal", () => {
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      maintenanceKcalOverride: 2200,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // 12 lb / 13 wk = 0.92 lb/wk → ~460 kcal/day deficit.
    expect(result.requiredWeeklyLossLb).toBeCloseTo(12 / 13, 2);
    expect(result.requiredDailyDeficitKcal).toBeGreaterThan(400);
    expect(result.requiredDailyDeficitKcal).toBeLessThan(520);
    // Maintenance = WHOOP TDEE 2200 used as-is; intake ≈ 1740, rounded to 25.
    expect(result.estimatedMaintenanceKcal).toBeGreaterThan(2000);
    expect(result.intakeKcal % 25).toBe(0);
    expect(result.intakeKcal).toBeGreaterThan(1500);
    expect(result.intakeKcal).toBeLessThan(2000);
    expect(result.warnings.pace).toBeNull();
    expect(result.warnings.belowSafetyFloor).toBe(false);
  });

  it("falls back to BMR × 1.4 when no active-kcal data is available", () => {
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      maintenanceKcalOverride: null,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // Sedentary multiplier kicks in. Allow ±2 kcal for compounding rounding
    // (result.bmrKcal is already rounded; estimatedMaintenanceKcal is rounded
    // from the raw unrounded BMR × 1.4, so round(rounded × 1.4) can differ
    // from round(raw × 1.4) by up to 1).
    const expected = result.bmrKcal * SEDENTARY_MULTIPLIER;
    expect(Math.abs(result.estimatedMaintenanceKcal - expected)).toBeLessThanOrEqual(2);
  });

  it("surfaces the pace warning when the goal is too aggressive", () => {
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      currentWeightLb: 175,
      deadline: D_PLUS(70), // 30 lb in 10 wk = 3 lb/wk
      maintenanceKcalOverride: 2200,
    });
    expect(result?.warnings.pace?.kind).toBe("too_aggressive");
  });

  it("surfaces the safety-floor warning when intake drops below BMR × 0.8", () => {
    // A very aggressive goal on a small frame can push intake below BMR×0.8.
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      currentWeightLb: 200,
      targetWeightLb: 145,
      deadline: D_PLUS(70), // 55 lb in 10 wk = 5.5 lb/wk → ~2750 kcal/day deficit
      maintenanceKcalOverride: null,
    });
    expect(result?.warnings.belowSafetyFloor).toBe(true);
  });

  it("returns the past-deadline pace warning rather than crashing on a same-day deadline", () => {
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      deadline: TODAY,
      maintenanceKcalOverride: 2200,
    });
    expect(result?.warnings.pace?.kind).toBe("deadline_past_or_today");
  });

  it("returns null when BMR cannot be computed (e.g., zero weight)", () => {
    const result = computeInitialIntakeTarget({
      ...baseProfile,
      currentWeightLb: 0,
      maintenanceKcalOverride: 2200,
    });
    expect(result).toBeNull();
  });
});

describe("deriveMacroTargets", () => {
  it("derives standard macros for a typical intake", () => {
    const m = deriveMacroTargets({
      currentWeightLb: 157,
      intakeKcal: 1750,
    });
    if ("error" in m) throw new Error("unexpected error result");
    // Protein 0.9 × 157 = 141 g; Fat 0.35 × 157 ≈ 55 g; Carbs fills.
    expect(m.proteinG).toBeCloseTo(141, 0);
    expect(m.fatG).toBeCloseTo(55, 0);
    expect(m.carbsG).toBeGreaterThan(150); // (1750 − 564 − 495)/4 ≈ 173
    // Sanity: kcal totals close to intake (within rounding ± a few kcal).
    const totalKcal = m.proteinG * 4 + m.carbsG * 4 + m.fatG * 9;
    expect(totalKcal).toBeGreaterThan(1740);
    expect(totalKcal).toBeLessThan(1755);
  });

  it("respects a protein override and recomputes carbs to fit kcal budget", () => {
    const m = deriveMacroTargets({
      currentWeightLb: 157,
      intakeKcal: 1750,
      overrides: { proteinG: 200 }, // user wants extra protein
    });
    if ("error" in m) throw new Error("unexpected error result");
    expect(m.proteinG).toBe(200);
    expect(m.fatG).toBeCloseTo(55, 0); // unchanged
    // Carbs = (1750 − 800 − 495) / 4 = 113.75 → ~114
    expect(m.carbsG).toBeGreaterThan(110);
    expect(m.carbsG).toBeLessThan(120);
  });

  it("returns all overrides verbatim when fully overridden", () => {
    const m = deriveMacroTargets({
      currentWeightLb: 157,
      intakeKcal: 1750,
      overrides: { proteinG: 180, carbsG: 150, fatG: 60 },
    });
    if ("error" in m) throw new Error("unexpected error result");
    expect(m).toEqual({ proteinG: 180, carbsG: 150, fatG: 60 });
  });

  it("returns error when override combo demands more kcal than budget allows", () => {
    // Protein 400g + Fat 100g = 1600 + 900 = 2500 kcal — exceeds 1750 budget.
    const m = deriveMacroTargets({
      currentWeightLb: 157,
      intakeKcal: 1750,
      overrides: { proteinG: 400, fatG: 100 },
    });
    expect("error" in m && m.error).toBe("impossible_combo");
  });
});

describe("latestIntakeKcal", () => {
  it("returns the last entry's intake kcal", () => {
    expect(
      latestIntakeKcal([
        { weekStartIso: "2026-W21", intakeKcal: 1750, reason: "initial", deltaFromPrev: 0 },
        {
          weekStartIso: "2026-W22",
          intakeKcal: 1700,
          reason: "recalibrated",
          deltaFromPrev: -50,
        },
      ]),
    ).toBe(1700);
  });

  it("returns null for empty history", () => {
    expect(latestIntakeKcal([])).toBeNull();
  });
});

describe("recalibrateWeeklyIntake", () => {
  // Helper: build N daily weigh-ins descending in weight from `start` by `dropPerDay`.
  const series = (start: number, dropPerDay: number, n: number): WeighIn[] =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(TODAY.getTime() - (n - 1 - i) * 86400000),
      weightLb: start - dropPerDay * i,
    }));

  it("skips when fewer than 5 weigh-ins are available", () => {
    const res = recalibrateWeeklyIntake({
      currentIntakeKcal: 1750,
      weighInsLb: series(157, 0.1, 4),
      avgDailyIntakeKcal: 1750,
      currentWeightLb: 156.6,
      targetWeightLb: 145,
      weeksToDeadline: 12,
    });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("insufficient_weigh_ins");
      expect(res.weighInCount).toBe(4);
      expect(res.currentIntakeKcal).toBe(1750);
    }
  });

  it("barely changes intake when loss tracks the target (rounds to ~no delta)", () => {
    // Aiming ~0.9 lb/wk. Observed loss ≈ 0.9 lb over the window, and logged
    // intake matches the current target → implied maintenance ≈ target + deficit,
    // so the new target lands within rounding of the current one.
    const res = recalibrateWeeklyIntake({
      currentIntakeKcal: 1750,
      // 7 weigh-ins, ~0.13 lb/day ≈ 0.9 lb over 7 days.
      weighInsLb: series(157, 0.13, 7),
      avgDailyIntakeKcal: 1750,
      currentWeightLb: 156.1,
      targetWeightLb: 145,
      weeksToDeadline: 12,
    });
    expect(res.status).toBe("recalibrated");
    if (res.status === "recalibrated") {
      expect(Math.abs(res.deltaKcal)).toBeLessThanOrEqual(50);
      expect(res.newIntakeKcal % 25).toBe(0);
    }
  });

  it("cuts intake (clamped to −200) when weight loss stalls", () => {
    // Logged 1750/day but barely lost weight → maintenance is lower than
    // assumed → intake must come down. Clamp protects against overcorrection.
    const res = recalibrateWeeklyIntake({
      currentIntakeKcal: 1750,
      weighInsLb: series(157, 0.0, 7), // flat — no loss
      avgDailyIntakeKcal: 1750,
      currentWeightLb: 157,
      targetWeightLb: 145,
      weeksToDeadline: 12,
    });
    expect(res.status).toBe("recalibrated");
    if (res.status === "recalibrated") {
      expect(res.direction).toBe("decrease");
      expect(res.deltaKcal).toBeGreaterThanOrEqual(-RECAL_MAX_DELTA_KCAL);
      expect(res.deltaKcal).toBeLessThan(0);
    }
  });

  it("raises intake (clamped to +200) when weight crashes faster than target", () => {
    // Lost way more than planned → maintenance is higher than assumed → bump
    // intake up so we don't overshoot the deficit and lose muscle.
    const res = recalibrateWeeklyIntake({
      currentIntakeKcal: 1750,
      weighInsLb: series(157, 0.6, 7), // ~4 lb in a week — far too fast
      avgDailyIntakeKcal: 1750,
      currentWeightLb: 153.4,
      targetWeightLb: 145,
      weeksToDeadline: 12,
    });
    expect(res.status).toBe("recalibrated");
    if (res.status === "recalibrated") {
      expect(res.direction).toBe("increase");
      expect(res.deltaKcal).toBe(RECAL_MAX_DELTA_KCAL);
    }
  });

  it("decreases intake hard when the user GAINED weight (clamped)", () => {
    const gaining = series(157, -0.3, 7); // gaining ~0.3 lb/day
    const res = recalibrateWeeklyIntake({
      currentIntakeKcal: 1750,
      weighInsLb: gaining,
      avgDailyIntakeKcal: 1750,
      currentWeightLb: 159,
      targetWeightLb: 145,
      weeksToDeadline: 12,
    });
    expect(res.status).toBe("recalibrated");
    if (res.status === "recalibrated") {
      expect(res.actualLossLb).toBeLessThan(0); // negative loss = gain
      expect(res.deltaKcal).toBe(-RECAL_MAX_DELTA_KCAL);
    }
  });
});

describe("applyMacroPeriodization", () => {
  const base = { proteinG: 141, carbsG: 173, fatG: 55 };

  it("adds carbs / cuts fat on a high-strain training day", () => {
    const { macros, applied } = applyMacroPeriodization({ base, strain: 16, overrides: null });
    expect(applied).toBe("training");
    expect(macros.carbsG).toBe(base.carbsG + PERIODIZATION_CARB_SHIFT_G);
    expect(macros.fatG).toBe(base.fatG - PERIODIZATION_FAT_SHIFT_G);
    expect(macros.proteinG).toBe(base.proteinG); // protein never shifts
  });

  it("cuts carbs / adds fat on a low-strain rest day", () => {
    const { macros, applied } = applyMacroPeriodization({ base, strain: 7, overrides: null });
    expect(applied).toBe("rest");
    expect(macros.carbsG).toBe(base.carbsG - PERIODIZATION_CARB_SHIFT_G);
    expect(macros.fatG).toBe(base.fatG + PERIODIZATION_FAT_SHIFT_G);
  });

  it("leaves macros unchanged on a moderate-strain day", () => {
    const { macros, applied } = applyMacroPeriodization({ base, strain: 12, overrides: null });
    expect(applied).toBe("none");
    expect(macros).toEqual(base);
  });

  it("leaves macros unchanged when strain is null (sync lag)", () => {
    const { macros, applied } = applyMacroPeriodization({ base, strain: null, overrides: null });
    expect(applied).toBe("none");
    expect(macros).toEqual(base);
  });

  it("never shifts an overridden macro — override wins absolutely", () => {
    // Fat is overridden; on a training day carbs still shift but fat holds.
    const { macros, applied } = applyMacroPeriodization({
      base,
      strain: 16,
      overrides: { fatG: 60 },
    });
    expect(applied).toBe("training");
    expect(macros.carbsG).toBe(base.carbsG + PERIODIZATION_CARB_SHIFT_G);
    expect(macros.fatG).toBe(base.fatG); // override → no shift
  });
});
