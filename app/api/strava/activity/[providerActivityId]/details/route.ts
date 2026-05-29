import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";

type ZoneBucket = {
  min: number;
  max: number;
  timeSec: number;
};

type ZoneBlock = {
  type: "heartrate" | "pace" | "power" | string;
  sensorBased: boolean;
  customZones: boolean;
  presentation?: "bpm" | "percent";
  label?: string;
  buckets: ZoneBucket[];
};

/** Same ±10 min tolerance used by run dedup in lib/merged-runs.ts. */
const WHOOP_MATCH_TOLERANCE_MS = 10 * 60 * 1000;

const WHOOP_PERCENT_ZONES: Array<{ keys: string[]; min: number; max: number }> = [
  { keys: ["zone_zero_milli"], min: 0, max: 50 },
  { keys: ["zone_one_milli"], min: 50, max: 60 },
  { keys: ["zone_two_milli"], min: 60, max: 70 },
  { keys: ["zone_three_milli"], min: 70, max: 80 },
  { keys: ["zone_four_milli"], min: 80, max: 90 },
  { keys: ["zone_five_milli"], min: 90, max: 100 },
];

function whoopBucketsFromZoneDurations(raw: unknown): ZoneBucket[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ZoneBucket[] = [];
  let any = false;
  for (const z of WHOOP_PERCENT_ZONES) {
    let sec = 0;
    for (const k of z.keys) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        sec += Math.max(0, Math.round(v / 1000));
      }
    }
    if (sec > 0) any = true;
    out.push({ min: z.min, max: z.max, timeSec: sec });
  }
  return any ? out : null;
}

async function findMatchingWhoopZoneBlock(
  userId: string,
  stravaStartAt: Date,
): Promise<ZoneBlock | null> {
  const lo = new Date(stravaStartAt.getTime() - WHOOP_MATCH_TOLERANCE_MS);
  const hi = new Date(stravaStartAt.getTime() + WHOOP_MATCH_TOLERANCE_MS);
  const workout = await prisma().whoopWorkout.findFirst({
    where: {
      userId,
      sportName: { contains: "run" },
      startAt: { gte: lo, lte: hi },
    },
    orderBy: { startAt: "asc" },
    select: { zoneDurations: true },
  });
  if (!workout) return null;
  const buckets = whoopBucketsFromZoneDurations(workout.zoneDurations);
  if (!buckets) return null;
  return {
    type: "heartrate",
    sensorBased: true,
    customZones: false,
    presentation: "percent",
    label: "WHOOP (% of WHOOP's HR-max estimate)",
    buckets,
  };
}

function extractPolyline(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const map = (rawPayload as { map?: unknown }).map;
  if (!map || typeof map !== "object") return null;
  const m = map as { summary_polyline?: unknown; polyline?: unknown };
  if (typeof m.polyline === "string" && m.polyline.length > 0) return m.polyline;
  if (typeof m.summary_polyline === "string" && m.summary_polyline.length > 0) {
    return m.summary_polyline;
  }
  return null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ providerActivityId: string }> },
) {
  try {
    const userId = await requireUserId();
    const { providerActivityId } = await ctx.params;

    const activity = await prisma().stravaActivity.findUnique({
      where: {
        userId_providerActivityId: { userId, providerActivityId },
      },
      select: { providerActivityId: true, rawPayload: true, startAt: true },
    });
    if (!activity) {
      return NextResponse.json(
        { ok: false, error: "Activity not found" },
        { status: 404 },
      );
    }

    const polyline = extractPolyline(activity.rawPayload);

    /**
     * Heart rate zones come exclusively from WHOOP. Strava only exposes a raw HR
     * stream (its /zones endpoint is Summit-only), so rather than re-bucket that
     * stream ourselves we surface the matching WHOOP workout's native zones.
     */
    let zones: ZoneBlock[] = [];
    let zonesError: string | null = null;
    let zonesHint: string | null = null;

    const whoopBlock = await findMatchingWhoopZoneBlock(userId, activity.startAt);
    if (whoopBlock) {
      zones = [whoopBlock];
      zonesHint = "WHOOP zone durations, as % of WHOOP's HR-max estimate.";
    } else {
      zonesError =
        "Heart rate zones come from WHOOP — no matching WHOOP workout for this run.";
    }

    return NextResponse.json({
      ok: true,
      polyline,
      zones,
      zonesError,
      zonesHint,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
