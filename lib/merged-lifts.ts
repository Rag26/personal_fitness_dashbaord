import type { LiftSessionTemplate } from "@prisma/client";

import {
  fetchHevyLiftingWorkoutsInRange,
  type HevyExerciseStored,
  type HevyLiftingRow,
} from "@/lib/hevy-lifting-queries";
import type { WhoopLiftingRow } from "@/lib/whoop-lifting-queries";
import { fetchWhoopLiftingWorkoutsInRange } from "@/lib/whoop-lifting-queries";

/**
 * Unified row for the lifting page table + calendars. Two sources:
 *   - WHOOP        — strain / HR / Z4–5 overlay; no exercise detail.
 *   - HEVY         — exercises + sets + muscle groups; no strain.
 *
 * When the same session shows up in both (Hevy logs the lift; WHOOP records
 * the strain), we collapse into a single HEVY row and attach the WHOOP overlay
 * via `whoopMatch`. Lone WHOOP rows still surface — sometimes the user trains
 * without logging in Hevy (or vice versa).
 */
export type MergedLiftRow =
  | (WhoopLiftingRow & {
      source: "WHOOP";
      title: string | null;
      exercises: HevyExerciseStored[] | null;
      muscleGroups: string[] | null;
      whoopMatch: null;
    })
  | {
      source: "HEVY";
      id: string;
      providerWorkoutId: string;
      title: string;
      startAt: Date;
      endAt: Date;
      sportName: "Hevy";
      scoreState: "HEVY";
      liftSessionTemplate: LiftSessionTemplate | null;
      exercises: HevyExerciseStored[];
      muscleGroups: string[];
      // Overlay fields come from a matched WHOOP workout, if any.
      whoopMatch:
        | {
            id: string;
            strain: number | null;
            averageHeartRateBpm: number | null;
            maxHeartRateBpm: number | null;
            kilojoule: number | null;
            zoneDurations: unknown;
            percentRecorded: number | null;
          }
        | null;
      // Mirror WHOOP fields so the table can read them uniformly.
      strain: number | null;
      averageHeartRateBpm: number | null;
      maxHeartRateBpm: number | null;
      kilojoule: number | null;
      zoneDurations: unknown;
      percentRecorded: number | null;
    };

/**
 * Strava `WeightTraining` activities still exist (some users have Strava
 * recording strength via Apple Watch). They no longer appear on the lifting
 * page — Hevy is the primary source there — but the existing
 * /api/strava-activities/[id]/lift-template route uses this to validate that
 * the activity is a strength session before letting the user tag it.
 */
export const STRAVA_LIFT_TYPES = new Set<string>(["WeightTraining"]);

export function isStravaLift(a: {
  type: string | null;
  sportType: string | null;
}) {
  const t = a.type?.trim() ?? "";
  const s = a.sportType?.trim() ?? "";
  return STRAVA_LIFT_TYPES.has(t) || STRAVA_LIFT_TYPES.has(s);
}

function likelySameSession(
  a: { startAt: Date; endAt: Date },
  b: { startAt: Date; endAt: Date },
) {
  const startDiffMin =
    Math.abs(a.startAt.getTime() - b.startAt.getTime()) / 60_000;
  if (startDiffMin > 10) return false;
  const durA = Math.max(0, a.endAt.getTime() - a.startAt.getTime());
  const durB = Math.max(0, b.endAt.getTime() - b.startAt.getTime());
  const durDiffMin = Math.abs(durA - durB) / 60_000;
  return durDiffMin <= 20;
}

function hevyToMerged(
  h: HevyLiftingRow,
  whoop: WhoopLiftingRow | null,
): MergedLiftRow {
  return {
    source: "HEVY",
    id: h.id,
    providerWorkoutId: h.providerWorkoutId,
    title: h.title,
    startAt: h.startAt,
    endAt: h.endAt,
    sportName: "Hevy",
    scoreState: "HEVY",
    liftSessionTemplate: h.liftSessionTemplate,
    exercises: h.exercises,
    muscleGroups: h.muscleGroups,
    whoopMatch: whoop
      ? {
          id: whoop.id,
          strain: whoop.strain,
          averageHeartRateBpm: whoop.averageHeartRateBpm,
          maxHeartRateBpm: whoop.maxHeartRateBpm,
          kilojoule: whoop.kilojoule,
          zoneDurations: whoop.zoneDurations,
          percentRecorded: whoop.percentRecorded,
        }
      : null,
    strain: whoop?.strain ?? null,
    averageHeartRateBpm: whoop?.averageHeartRateBpm ?? null,
    maxHeartRateBpm: whoop?.maxHeartRateBpm ?? null,
    kilojoule: whoop?.kilojoule ?? null,
    zoneDurations: whoop?.zoneDurations ?? null,
    percentRecorded: whoop?.percentRecorded ?? null,
  };
}

function whoopToMerged(w: WhoopLiftingRow): MergedLiftRow {
  return {
    ...w,
    source: "WHOOP",
    title: null,
    exercises: null,
    muscleGroups: null,
    whoopMatch: null,
  };
}

export async function fetchMergedLiftsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<MergedLiftRow[]> {
  const [whoop, hevy] = await Promise.all([
    fetchWhoopLiftingWorkoutsInRange(userId, start, end),
    fetchHevyLiftingWorkoutsInRange(userId, start, end),
  ]);

  // For each Hevy row, claim the closest matching WHOOP row (if any). Tracked
  // claims so a single WHOOP session can't overlay two Hevy workouts.
  const claimedWhoop = new Set<string>();
  const hevyRows: MergedLiftRow[] = hevy.map((h) => {
    const candidate = whoop.find(
      (w) => !claimedWhoop.has(w.id) && likelySameSession(w, h),
    );
    if (candidate) claimedWhoop.add(candidate.id);
    return hevyToMerged(h, candidate ?? null);
  });

  const orphanWhoop: MergedLiftRow[] = whoop
    .filter((w) => !claimedWhoop.has(w.id))
    .map(whoopToMerged);

  const out = [...hevyRows, ...orphanWhoop];
  out.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return out;
}

export async function fetchMergedLiftStartsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<Date[]> {
  const rows = await fetchMergedLiftsInRange(userId, start, end);
  return rows.map((r) => r.startAt).sort((a, b) => a.getTime() - b.getTime());
}
