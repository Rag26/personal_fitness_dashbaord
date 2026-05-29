import { prisma } from "@/lib/db";

/** Normalized run for analytics (Strava + WHOOP, dedup'd with Strava preferred). */
export type NormalizedRun = {
  startAt: Date;
  distanceMeters: number | null;
  movingTimeSec: number | null;
};

/** Strava and WHOOP rows of the same workout typically start within a couple
 * minutes of each other; ±10 min is comfortably forgiving and avoids collapsing
 * back-to-back workouts (e.g. a warmup jog + main run started 15+ min apart). */
const DEDUP_TOLERANCE_MS = 10 * 60 * 1000;

/** WHOOP sportName is stored lowercased ("running", "trail_running", etc.). */
const WHOOP_RUN_FILTER = { sportName: { contains: "run" } } as const;

/** Returns WHOOP rows that have no Strava counterpart within ±DEDUP_TOLERANCE_MS. */
function whoopRunsNotInStrava<S extends { startAt: Date }, W extends { startAt: Date }>(
  strava: S[],
  whoop: W[],
): W[] {
  if (strava.length === 0) return whoop;
  const stravaTimes = strava.map((s) => s.startAt.getTime()).sort((a, b) => a - b);
  return whoop.filter((w) => {
    const t = w.startAt.getTime();
    for (const st of stravaTimes) {
      if (Math.abs(st - t) <= DEDUP_TOLERANCE_MS) return false;
      if (st > t + DEDUP_TOLERANCE_MS) break;
    }
    return true;
  });
}

function whoopMovingTimeSec(w: { startAt: Date; endAt: Date }): number {
  return Math.max(0, Math.round((w.endAt.getTime() - w.startAt.getTime()) / 1000));
}

export async function fetchNormalizedRunsInRange(
  userId: string,
  start: Date,
  end: Date = new Date(),
): Promise<NormalizedRun[]> {
  const [strava, whoop] = await Promise.all([
    prisma().stravaActivity.findMany({
      where: {
        userId,
        startAt: { gte: start, lte: end },
        OR: [{ type: "Run" }, { sportType: "Run" }],
      },
      select: {
        startAt: true,
        distanceMeters: true,
        movingTimeSec: true,
      },
    }),
    prisma().whoopWorkout.findMany({
      where: {
        userId,
        ...WHOOP_RUN_FILTER,
        startAt: { gte: start, lte: end },
      },
      select: { startAt: true, endAt: true, distanceMeters: true },
      orderBy: { startAt: "asc" },
    }),
  ]);

  const whoopOnly = whoopRunsNotInStrava(strava, whoop);
  const out: NormalizedRun[] = [
    ...strava.map((r) => ({
      startAt: r.startAt,
      distanceMeters: r.distanceMeters,
      movingTimeSec: r.movingTimeSec,
    })),
    ...whoopOnly.map((w) => ({
      startAt: w.startAt,
      distanceMeters: w.distanceMeters ?? null,
      movingTimeSec: whoopMovingTimeSec(w),
    })),
  ];
  out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return out;
}

/** Kept as an alias for callers that previously distinguished sources. */
export async function fetchStravaRunsInRange(
  userId: string,
  start: Date,
  end: Date = new Date(),
): Promise<NormalizedRun[]> {
  return fetchNormalizedRunsInRange(userId, start, end);
}

export type RunSource = "STRAVA" | "WHOOP";

export type RunTableRow = {
  rowKey: string;
  source: RunSource;
  providerActivityId: string;
  name: string;
  startAt: Date;
  distanceMeters: number | null;
  movingTimeSec: number | null;
  totalElevationM: number | null;
  averageHrBpm: number | null;
  maxHrBpm: number | null;
};

export async function fetchRecentRunTableRows(
  userId: string,
  take: number,
): Promise<RunTableRow[]> {
  const [strava, whoop] = await Promise.all([
    prisma().stravaActivity.findMany({
      where: {
        userId,
        OR: [{ type: "Run" }, { sportType: "Run" }],
      },
      orderBy: { startAt: "desc" },
      take,
      select: {
        providerActivityId: true,
        name: true,
        startAt: true,
        distanceMeters: true,
        movingTimeSec: true,
        totalElevationM: true,
        averageHrBpm: true,
        maxHrBpm: true,
      },
    }),
    prisma().whoopWorkout.findMany({
      where: { userId, ...WHOOP_RUN_FILTER },
      orderBy: { startAt: "desc" },
      take,
      select: {
        providerWorkoutId: true,
        startAt: true,
        endAt: true,
        distanceMeters: true,
        averageHeartRateBpm: true,
        maxHeartRateBpm: true,
        altitudeGainMeters: true,
        sportName: true,
      },
    }),
  ]);

  const stravaRows: RunTableRow[] = strava.map((r) => ({
    rowKey: `s:${r.providerActivityId}`,
    source: "STRAVA",
    providerActivityId: r.providerActivityId,
    name: r.name ?? "Run",
    startAt: r.startAt,
    distanceMeters: r.distanceMeters,
    movingTimeSec: r.movingTimeSec,
    totalElevationM: r.totalElevationM,
    averageHrBpm: r.averageHrBpm,
    maxHrBpm: r.maxHrBpm,
  }));

  const whoopOnly = whoopRunsNotInStrava(strava, whoop);
  const whoopRows: RunTableRow[] = whoopOnly.map((w) => ({
    rowKey: `w:${w.providerWorkoutId}`,
    source: "WHOOP",
    providerActivityId: w.providerWorkoutId,
    name: w.sportName === "running" ? "Run" : w.sportName,
    startAt: w.startAt,
    distanceMeters: w.distanceMeters ?? null,
    movingTimeSec: whoopMovingTimeSec(w),
    totalElevationM: w.altitudeGainMeters ?? null,
    averageHrBpm: w.averageHeartRateBpm,
    maxHrBpm: w.maxHeartRateBpm,
  }));

  const merged = [...stravaRows, ...whoopRows];
  merged.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return merged.slice(0, take);
}

/**
 * Returns the user's reference max HR for run intensity normalization.
 * Uses the highest observed maxHrBpm across Strava runs and WHOOP running workouts.
 * Returns null when no run has a usable HR sample.
 */
export async function fetchUserReferenceMaxHr(
  userId: string,
): Promise<number | null> {
  const [strava, whoop] = await Promise.all([
    prisma().stravaActivity.aggregate({
      where: {
        userId,
        OR: [{ type: "Run" }, { sportType: "Run" }],
      },
      _max: { maxHrBpm: true },
    }),
    prisma().whoopWorkout.aggregate({
      where: { userId, ...WHOOP_RUN_FILTER },
      _max: { maxHeartRateBpm: true },
    }),
  ]);

  const candidates = [strava._max.maxHrBpm, whoop._max.maxHeartRateBpm].filter(
    (v): v is number => typeof v === "number" && v > 100,
  );
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/** Fetch recent run distances (miles) to build an adaptive training profile. */
export async function fetchRecentRunDistancesMiForProfile(
  userId: string,
  take: number = 90,
): Promise<number[]> {
  const [strava, whoop] = await Promise.all([
    prisma().stravaActivity.findMany({
      where: { userId, OR: [{ type: "Run" }, { sportType: "Run" }] },
      orderBy: { startAt: "desc" },
      take,
      select: { startAt: true, distanceMeters: true },
    }),
    prisma().whoopWorkout.findMany({
      where: { userId, ...WHOOP_RUN_FILTER },
      orderBy: { startAt: "desc" },
      take,
      select: { startAt: true, distanceMeters: true },
    }),
  ]);

  const whoopOnly = whoopRunsNotInStrava(strava, whoop);
  const combined = [
    ...strava.map((r) => ({ startAt: r.startAt, distanceMeters: r.distanceMeters })),
    ...whoopOnly.map((w) => ({ startAt: w.startAt, distanceMeters: w.distanceMeters ?? null })),
  ];
  combined.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return combined
    .slice(0, take)
    .map((r) => r.distanceMeters ?? 0)
    .filter((m) => Number.isFinite(m) && m > 0)
    .map((m) => m / 1609.344);
}

/** Run start times in a window — used for calendar markers (Strava + WHOOP, dedup'd). */
export async function fetchRunStartsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<Date[]> {
  const [strava, whoop] = await Promise.all([
    prisma().stravaActivity.findMany({
      where: {
        userId,
        startAt: { gte: start, lt: end },
        OR: [{ type: "Run" }, { sportType: "Run" }],
      },
      select: { startAt: true },
      orderBy: { startAt: "asc" },
    }),
    prisma().whoopWorkout.findMany({
      where: {
        userId,
        ...WHOOP_RUN_FILTER,
        startAt: { gte: start, lt: end },
      },
      select: { startAt: true },
      orderBy: { startAt: "asc" },
    }),
  ]);
  const whoopOnly = whoopRunsNotInStrava(strava, whoop);
  return [...strava.map((r) => r.startAt), ...whoopOnly.map((w) => w.startAt)].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
}

/** @deprecated alias retained while call sites migrate to fetchRunStartsInRange */
export const fetchStravaRunStartsInRange = fetchRunStartsInRange;
