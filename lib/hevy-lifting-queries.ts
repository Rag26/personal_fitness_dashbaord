import type { LiftSessionTemplate } from "@prisma/client";

import { prisma } from "@/lib/db";

export type HevyExerciseStored = {
  index: number;
  exerciseTemplateId: string;
  title: string;
  primaryMuscleGroup: string;
  secondaryMuscleGroups: string[];
  notes: string | null;
  sets: {
    index: number;
    type: string | null;
    reps: number | null;
    weightKg: number | null;
    distanceMeters: number | null;
    durationSeconds: number | null;
    rpe: number | null;
  }[];
};

export type HevyLiftingRow = {
  id: string;
  providerWorkoutId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  liftSessionTemplate: LiftSessionTemplate | null;
  liftSessionTemplateAuto: boolean;
  exercises: HevyExerciseStored[];
  muscleGroups: string[];
};

export async function fetchHevyLiftingWorkoutsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<HevyLiftingRow[]> {
  const rows = await prisma().hevyWorkout.findMany({
    where: { userId, startAt: { gte: start, lt: end } },
    orderBy: { startAt: "desc" },
    select: {
      id: true,
      providerWorkoutId: true,
      title: true,
      startAt: true,
      endAt: true,
      liftSessionTemplate: true,
      liftSessionTemplateAuto: true,
      exercises: true,
      muscleGroups: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    providerWorkoutId: r.providerWorkoutId,
    title: r.title,
    startAt: r.startAt,
    endAt: r.endAt,
    liftSessionTemplate: r.liftSessionTemplate,
    liftSessionTemplateAuto: r.liftSessionTemplateAuto,
    exercises: Array.isArray(r.exercises)
      ? (r.exercises as unknown as HevyExerciseStored[])
      : [],
    muscleGroups: r.muscleGroups,
  }));
}

/**
 * Presence-based tally: for each Hevy workout in [start, end), every muscle
 * group in its `muscleGroups[]` counts +1 (a single workout can contribute to
 * many groups). Used by the lifting page's "this week" panel against
 * MuscleGroupWeeklyTarget.
 */
export async function countMuscleGroupSessionsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<Record<string, number>> {
  const rows = await prisma().hevyWorkout.findMany({
    where: { userId, startAt: { gte: start, lt: end } },
    select: { muscleGroups: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) {
    for (const g of r.muscleGroups) {
      counts[g] = (counts[g] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Format the exercises list for the lifting page table — one line per
 * exercise, e.g. "Bench Press 5×8 @ 100kg" (top-set summary).
 */
export function summarizeExerciseLine(ex: HevyExerciseStored): string {
  if (ex.sets.length === 0) return ex.title;

  const working = ex.sets.filter((s) => (s.reps ?? 0) > 0);
  if (working.length === 0) return ex.title;

  const reps = working[0].reps ?? 0;
  const weight = working[0].weightKg;
  const setCount = working.length;
  const weightStr =
    weight != null && Number.isFinite(weight)
      ? ` @ ${Number.isInteger(weight) ? weight : weight.toFixed(1)} kg`
      : "";
  return `${ex.title} — ${setCount}×${reps}${weightStr}`;
}
