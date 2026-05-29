import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { getValidStravaAccessTokenForUser } from "@/lib/strava";
import { fetchOrComputeActivityHrZones, HR_ZONE_SCHEMES } from "@/lib/hr-zones";

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
  { keys: ["zone_zero_milli", "zone_one_milli"], min: 0, max: 60 },
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
      select: { providerActivityId: true, rawPayload: true, maxHrBpm: true, startAt: true },
    });
    if (!activity) {
      return NextResponse.json(
        { ok: false, error: "Activity not found" },
        { status: 404 },
      );
    }

    const polyline = extractPolyline(activity.rawPayload);
    const accessToken = await getValidStravaAccessTokenForUser(userId);

    /**
     * We compute zones ourselves from the HR stream against the user's HR profile
     * (max HR + scheme). Strava's /zones is Summit-only and returns 402 for many
     * athletes, so we don't depend on it.
     */
    const result = await fetchOrComputeActivityHrZones({
      userId,
      providerActivityId,
      accessToken,
      activityMaxHrBpm: activity.maxHrBpm,
    });

    let zones: ZoneBlock[] = [];
    let zonesError: string | null = null;
    let zonesHint: string | null = null;
    if (result.ok) {
      const edges = result.aggregate.zoneEdgesBpm;
      const durs = result.aggregate.zoneDurationsSec;
      const buckets: ZoneBucket[] = durs.map((sec, i) => ({
        min: edges[i] ?? 0,
        max: edges[i + 1] ?? edges[i] ?? 0,
        timeSec: sec,
      }));
      zones = [
        {
          type: "heartrate",
          sensorBased: true,
          customZones: false,
          presentation: "bpm",
          label: `Strava (computed from your ${result.hrMaxBpm} bpm max)`,
          buckets,
        },
      ];
      const scheme = HR_ZONE_SCHEMES[result.schemeKey];
      zonesHint = `Computed from your HR stream against ${result.hrMaxBpm} bpm max (${scheme?.description ?? "your scheme"})${result.cached ? " — cached" : ""}.`;
    } else {
      zonesError = result.message;
    }

    // Append the matching WHOOP workout's zone block (if any) so users can
    // compare both providers' time-in-zone side-by-side.
    const whoopBlock = await findMatchingWhoopZoneBlock(userId, activity.startAt);
    if (whoopBlock) zones.push(whoopBlock);

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
