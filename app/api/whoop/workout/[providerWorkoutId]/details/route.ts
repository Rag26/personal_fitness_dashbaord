import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";

type ZoneBucket = { min: number; max: number; timeSec: number };
type ZoneBlock = {
  type: "heartrate";
  sensorBased: boolean;
  customZones: boolean;
  presentation: "bpm" | "percent";
  label?: string;
  buckets: ZoneBucket[];
};

/**
 * WHOOP `zone_durations` keys (v2 workout API). Values in milliseconds.
 * Each WHOOP band is a % of WHOOP's own HR-max estimate:
 *   zone_zero = <50%, zone_one = 50–60%, …, zone_five = ≥90%.
 *
 * We collapse Z0 (<50%) into Z1 so the display matches Strava's 5-zone model:
 * `lib/hr-zones.ts:aggregateHrZones` dumps any below-Z1 time into Z1 anyway,
 * so Strava's "Z1 · 50–60%" already bundles <50% time. Doing the same here
 * keeps both providers semantically aligned.
 */
const WHOOP_PERCENT_ZONES: Array<{ keys: string[]; min: number; max: number }> = [
  { keys: ["zone_zero_milli", "zone_one_milli"], min: 0, max: 60 },
  { keys: ["zone_two_milli"], min: 60, max: 70 },
  { keys: ["zone_three_milli"], min: 70, max: 80 },
  { keys: ["zone_four_milli"], min: 80, max: 90 },
  { keys: ["zone_five_milli"], min: 90, max: 100 },
];

function bucketsFromZoneDurations(raw: unknown): ZoneBucket[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ZoneBucket[] = [];
  let anyPresent = false;
  for (const z of WHOOP_PERCENT_ZONES) {
    let sec = 0;
    for (const k of z.keys) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        sec += Math.max(0, Math.round(v / 1000));
      }
    }
    if (sec > 0) anyPresent = true;
    out.push({ min: z.min, max: z.max, timeSec: sec });
  }
  return anyPresent ? out : null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ providerWorkoutId: string }> },
) {
  try {
    const userId = await requireUserId();
    const { providerWorkoutId } = await ctx.params;

    const workout = await prisma().whoopWorkout.findUnique({
      where: {
        userId_providerWorkoutId: { userId, providerWorkoutId },
      },
      select: {
        providerWorkoutId: true,
        zoneDurations: true,
      },
    });

    if (!workout) {
      return NextResponse.json(
        { ok: false, error: "Workout not found" },
        { status: 404 },
      );
    }

    let zones: ZoneBlock[] = [];
    let zonesError: string | null = null;
    let zonesHint: string | null = null;

    const buckets = bucketsFromZoneDurations(workout.zoneDurations);
    if (!buckets) {
      zonesError = "WHOOP didn't return zone durations for this workout.";
    } else {
      zones = [
        {
          type: "heartrate",
          sensorBased: true,
          customZones: false,
          presentation: "percent",
          label: "WHOOP (% of WHOOP's HR-max estimate)",
          buckets,
        },
      ];
      zonesHint =
        "WHOOP zone durations, as % of WHOOP's HR-max estimate. Z1 bundles all time below 60% (matches the Strava zone model).";
    }

    return NextResponse.json({
      ok: true,
      polyline: null,
      zones,
      zonesError,
      zonesHint,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
