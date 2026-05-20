import { prisma } from "@/lib/db";

/** Normalized run for analytics (Strava runs only). */
export type NormalizedRun = {
  startAt: Date;
  distanceMeters: number | null;
  movingTimeSec: number | null;
};

export async function fetchNormalizedRunsInRange(
  userId: string,
  start: Date,
  end: Date = new Date(),
): Promise<NormalizedRun[]> {
  const strava = await prisma().stravaActivity.findMany({
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
  });
  const out: NormalizedRun[] = strava.map((r) => ({
    startAt: r.startAt,
    distanceMeters: r.distanceMeters,
    movingTimeSec: r.movingTimeSec,
  }));
  out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return out;
}

/** Strava runs only. Kept as an alias for callers that previously distinguished sources. */
export async function fetchStravaRunsInRange(
  userId: string,
  start: Date,
  end: Date = new Date(),
): Promise<NormalizedRun[]> {
  return fetchNormalizedRunsInRange(userId, start, end);
}

export type RunTableRow = {
  rowKey: string;
  source: "STRAVA";
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
  const strava = await prisma().stravaActivity.findMany({
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
  });

  return strava.map((r) => ({
    rowKey: `s:${r.providerActivityId}`,
    source: "STRAVA" as const,
    providerActivityId: r.providerActivityId,
    name: r.name ?? "Run",
    startAt: r.startAt,
    distanceMeters: r.distanceMeters,
    movingTimeSec: r.movingTimeSec,
    totalElevationM: r.totalElevationM,
    averageHrBpm: r.averageHrBpm,
    maxHrBpm: r.maxHrBpm,
  }));
}

/**
 * Returns the user's reference max HR for run intensity normalization.
 * Uses the highest observed `maxHrBpm` across all of their Strava runs.
 * Returns null when no run has a usable HR sample.
 */
export async function fetchUserReferenceMaxHr(
  userId: string,
): Promise<number | null> {
  const strava = await prisma().stravaActivity.aggregate({
    where: {
      userId,
      OR: [{ type: "Run" }, { sportType: "Run" }],
    },
    _max: { maxHrBpm: true },
  });

  const v = strava._max.maxHrBpm;
  if (typeof v !== "number" || v <= 100) return null;
  return v;
}

/** Fetch recent run distances (miles) to build an adaptive training profile. */
export async function fetchRecentRunDistancesMiForProfile(
  userId: string,
  take: number = 90,
): Promise<number[]> {
  const strava = await prisma().stravaActivity.findMany({
    where: { userId, OR: [{ type: "Run" }, { sportType: "Run" }] },
    orderBy: { startAt: "desc" },
    take,
    select: { distanceMeters: true },
  });

  return strava
    .map((r) => r.distanceMeters ?? 0)
    .filter((m) => Number.isFinite(m) && m > 0)
    .map((m) => m / 1609.344);
}

/** Strava runs only — start times for calendar markers. */
export async function fetchStravaRunStartsInRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<Date[]> {
  const rows = await prisma().stravaActivity.findMany({
    where: {
      userId,
      startAt: { gte: start, lt: end },
      OR: [{ type: "Run" }, { sportType: "Run" }],
    },
    select: { startAt: true },
    orderBy: { startAt: "asc" },
  });
  return rows.map((r) => r.startAt);
}
