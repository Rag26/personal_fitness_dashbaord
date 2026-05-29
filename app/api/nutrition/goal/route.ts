import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import {
  ageYearsAt,
  type BiologicalSex,
} from "@/lib/nutrition-burn";
import {
  computeInitialIntakeTarget,
  isoWeek,
  type IntakeHistoryEntry,
} from "@/lib/nutrition-goal";

/**
 * Set or update the user's active weight goal. POST is the only verb — there
 * is no separate PUT/DELETE; "updating" soft-deletes the previous active goal
 * and inserts a new row, so intakeHistory and recalibration timestamps reset
 * cleanly with each new goal.
 *
 * Form fields:
 *   targetWeightLb   number (80 – 400)
 *   deadlineDate     YYYY-MM-DD (must be at least 1 day in the future)
 *   startWeightLb    number (80 – 500) — user's current weight at goal start
 *
 * Validation requires height + DOB + biologicalSex on the user profile so we
 * can compute BMR. If any are missing, we redirect with a "fill profile first"
 * error pointing the user at Settings.
 */
const GoalSchema = z.object({
  targetWeightLb: z.preprocess(
    (v) => (v == null || v === "" ? NaN : Number(v)),
    z.number().min(80).max(400),
  ),
  deadlineDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Deadline must be YYYY-MM-DD"),
  startWeightLb: z.preprocess(
    (v) => (v == null || v === "" ? NaN : Number(v)),
    z.number().min(80).max(500),
  ),
});

function redirect(req: Request, qs: string) {
  return NextResponse.redirect(new URL(`/nutrition?${qs}`, req.url), {
    status: 303,
  });
}

const RECENT_WHOOP_WINDOW_DAYS = 30;

export async function POST(req: Request) {
  const userId = await requireUserId();
  const form = await req.formData();
  const parsed = GoalSchema.safeParse({
    targetWeightLb: form.get("targetWeightLb"),
    deadlineDate: form.get("deadlineDate"),
    startWeightLb: form.get("startWeightLb"),
  });
  if (!parsed.success) {
    const reason = encodeURIComponent(
      parsed.error.issues[0]?.message ?? "Invalid goal input",
    );
    return redirect(req, `nutrition=error&reason=${reason}`);
  }

  const { targetWeightLb, deadlineDate, startWeightLb } = parsed.data;

  // Compose deadline as UTC midnight on the target day, matching the
  // ManualWeightLog / DailyNutritionLog convention.
  const [y, m, d] = deadlineDate.split("-").map(Number);
  const deadline = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));

  // Pull profile inputs needed to compute BMR. The user must have height +
  // DOB + sex set in /settings → Body profile before they can create a goal.
  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      biologicalSex: true,
      timezone: true,
    },
  });
  if (!user || !user.heightCm || !user.dateOfBirth || !user.biologicalSex) {
    return redirect(
      req,
      "nutrition=error&reason=missing_profile_fill_height_dob_sex_in_settings",
    );
  }

  const sex: BiologicalSex =
    user.biologicalSex === "MALE" || user.biologicalSex === "FEMALE"
      ? user.biologicalSex
      : "OTHER";

  // 30-day rolling avg of WHOOP full-day energy burn (kcal, TDEE). Null if no
  // scored cycles have energyKcal yet — the math falls back to BMR × 1.4.
  const since = new Date(Date.now() - RECENT_WHOOP_WINDOW_DAYS * 86400000);
  const energyRows = await prisma().dailyWhoopStat.findMany({
    where: {
      userId,
      energyKcal: { not: null },
      date: { gte: since },
    },
    select: { energyKcal: true },
  });
  const energyVals = energyRows
    .map((r) => r.energyKcal)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const maintenanceKcalOverride =
    energyVals.length > 0
      ? energyVals.reduce((a, b) => a + b, 0) / energyVals.length
      : null;

  const today = new Date();
  const ageYears = ageYearsAt(user.dateOfBirth, today);

  const result = computeInitialIntakeTarget({
    today,
    deadline,
    currentWeightLb: startWeightLb,
    targetWeightLb,
    heightCm: user.heightCm,
    ageYears,
    sex,
    maintenanceKcalOverride,
  });
  if (!result) {
    return redirect(req, "nutrition=error&reason=could_not_compute_intake");
  }
  if (result.warnings.pace?.kind === "deadline_past_or_today") {
    return redirect(req, "nutrition=error&reason=deadline_must_be_in_future");
  }

  // Build the initial intakeHistory entry. Week key = the ISO week the goal
  // starts in; reason = "initial"; delta from prev = 0.
  const tz = normalizeUserTimezone(user.timezone);
  void tz; // reserved for future per-TZ ISO-week alignment
  const initialEntry: IntakeHistoryEntry = {
    weekStartIso: isoWeek(today),
    intakeKcal: result.intakeKcal,
    reason: "initial",
    deltaFromPrev: 0,
  };

  // Soft-delete the previous active goal (only one isActive=true per user),
  // then insert the new one. Sequential to keep the invariant easy to reason
  // about; the row count is always 1, so a transaction is overkill.
  await prisma().weightGoal.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });
  await prisma().weightGoal.create({
    data: {
      userId,
      targetWeightLb,
      deadlineDate: deadline,
      startWeightLb,
      isActive: true,
      lastRecalibratedIsoWeek: null,
      intakeHistory: [initialEntry] as unknown as Prisma.InputJsonValue,
      macroOverrides: Prisma.JsonNull,
    },
  });

  // Echo pace warnings back as a non-blocking notice (form already saved).
  if (result.warnings.pace?.kind === "too_aggressive") {
    return redirect(req, "nutrition=goal_saved_pace_aggressive");
  }
  if (result.warnings.pace?.kind === "too_slow") {
    return redirect(req, "nutrition=goal_saved_pace_slow");
  }
  if (result.warnings.belowSafetyFloor) {
    return redirect(req, "nutrition=goal_saved_below_safety_floor");
  }
  return redirect(req, "nutrition=goal_saved");
}
