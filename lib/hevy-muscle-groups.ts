import type { LiftSessionTemplate } from "@prisma/client";

/**
 * Hevy returns muscle groups as lowercase snake_case strings. We store them
 * unchanged and only group them into PUSH / PULL / LEGS for the higher-level
 * session classifier — per-muscle-group tallies use the raw values so we can
 * track "shoulders", "forearms", "abs" independently of the split label.
 *
 * If Hevy adds a new value we don't recognize, classifyLiftSession() simply
 * ignores it (it doesn't count toward push/pull/legs). The per-muscle-group
 * tally still picks it up because that's a free-form string match.
 */

export const PUSH_GROUPS: ReadonlySet<string> = new Set([
  "chest",
  "shoulders",
  "front_deltoids",
  "triceps",
]);

export const PULL_GROUPS: ReadonlySet<string> = new Set([
  "back",
  "upper_back",
  "lower_back",
  "lats",
  "traps",
  "rear_deltoids",
  "biceps",
]);

export const LEGS_GROUPS: ReadonlySet<string> = new Set([
  "quadriceps",
  "hamstrings",
  "glutes",
  "calves",
  "adductors",
  "abductors",
]);

/**
 * Curated dropdown options for the muscle-group goals UI. Hevy has more values
 * than this; we surface the ones a user is likely to want a weekly target for.
 * "Other" muscle groups can still be tracked — they'll show up in the workout
 * row but won't have a goal until added here.
 */
export const MUSCLE_GROUP_OPTIONS: readonly { value: string; label: string }[] =
  [
    { value: "chest", label: "Chest" },
    { value: "back", label: "Back" },
    { value: "lats", label: "Lats" },
    { value: "shoulders", label: "Shoulders" },
    { value: "biceps", label: "Biceps" },
    { value: "triceps", label: "Triceps" },
    { value: "forearms", label: "Forearms" },
    { value: "quadriceps", label: "Quadriceps" },
    { value: "hamstrings", label: "Hamstrings" },
    { value: "glutes", label: "Glutes" },
    { value: "calves", label: "Calves" },
    { value: "abs", label: "Abs" },
    { value: "core", label: "Core" },
    { value: "traps", label: "Traps" },
    { value: "rear_deltoids", label: "Rear delts" },
  ];

export function muscleGroupLabel(value: string): string {
  const match = MUSCLE_GROUP_OPTIONS.find((o) => o.value === value);
  if (match) return match.label;
  // Fallback: title-case the snake_case Hevy value.
  return value
    .split("_")
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ");
}

type ExerciseWithGroups = {
  primaryMuscleGroup?: string | null;
  secondaryMuscleGroups?: readonly string[] | null;
};

/**
 * Pick PUSH / PULL / LEGS from the exercises in a workout. Tallies each
 * exercise's *primary* muscle group into one of the three buckets; secondary
 * groups are ignored (a chest fly's secondary "shoulders" hit shouldn't tip a
 * chest day into ambiguity). Returns null when no bucket gets a plurality —
 * e.g. a pure abs day, or a mixed cardio+strength session.
 *
 * Ties broken in PUSH > PULL > LEGS order (arbitrary but stable so re-syncs
 * don't flap classification on borderline workouts).
 */
export function classifyLiftSession(
  exercises: readonly ExerciseWithGroups[],
): LiftSessionTemplate | null {
  let push = 0;
  let pull = 0;
  let legs = 0;
  let tagged = 0;

  for (const ex of exercises) {
    const primary = (ex.primaryMuscleGroup ?? "").trim().toLowerCase();
    if (!primary) continue;
    if (PUSH_GROUPS.has(primary)) {
      push += 1;
      tagged += 1;
    } else if (PULL_GROUPS.has(primary)) {
      pull += 1;
      tagged += 1;
    } else if (LEGS_GROUPS.has(primary)) {
      legs += 1;
      tagged += 1;
    }
  }

  if (tagged === 0) return null;

  const max = Math.max(push, pull, legs);
  if (max === 0) return null;
  if (max === push) return "PUSH";
  if (max === pull) return "PULL";
  return "LEGS";
}

/**
 * Flat, deduplicated list of every primary + secondary muscle group hit by
 * any exercise in the workout. Used for per-muscle-group weekly tallies —
 * stored on HevyWorkout.muscleGroups so the goals query doesn't have to walk
 * the JSON exercises blob.
 */
export function expandWorkoutMuscleGroups(
  exercises: readonly ExerciseWithGroups[],
): string[] {
  const seen = new Set<string>();
  for (const ex of exercises) {
    const primary = (ex.primaryMuscleGroup ?? "").trim().toLowerCase();
    if (primary) seen.add(primary);
    for (const sec of ex.secondaryMuscleGroups ?? []) {
      const v = sec.trim().toLowerCase();
      if (v) seen.add(v);
    }
  }
  return Array.from(seen).sort();
}
