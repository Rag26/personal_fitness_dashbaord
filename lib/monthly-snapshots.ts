import { prisma } from "@/lib/db";

type StravaMonthRow = {
  year: number;
  month: number;
  runCount: number;
  runDistanceMeters: number;
  runMovingTimeSec: number;
  runElevGainM: number | null;
  avgPaceSecPerMi: number | null;
};

type WhoopMonthRow = {
  year: number;
  month: number;
  avgWhoopRecovery: number | null;
  avgWhoopStrain: number | null;
  avgWhoopHrvMs: number | null;
  avgWhoopWeightKg: number | null;
  whoopDaysCount: number;
};

/**
 * Rebuilds monthly rollups from raw Strava + WHOOP rows (full replace per user).
 * Call after sync so long-term / journey views stay fast and accurate.
 */
export async function recomputeMonthlyFitnessSnapshots(userId: string) {
  const stravaRows = await prisma().$queryRaw<StravaMonthRow[]>`
    SELECT
      EXTRACT(YEAR FROM "startAt")::int AS year,
      EXTRACT(MONTH FROM "startAt")::int AS month,
      COUNT(*)::int AS "runCount",
      COALESCE(SUM("distanceMeters"), 0)::int AS "runDistanceMeters",
      COALESCE(SUM("movingTimeSec"), 0)::int AS "runMovingTimeSec",
      SUM("totalElevationM")::float AS "runElevGainM",
      CASE
        WHEN COALESCE(SUM("distanceMeters"), 0) > 0
        THEN (SUM("movingTimeSec")::float / SUM("distanceMeters")::float) * 1609.344
        ELSE NULL
      END AS "avgPaceSecPerMi"
    FROM "StravaActivity"
    WHERE "userId" = ${userId}
      AND ("type" = 'Run' OR "sportType" = 'Run')
    GROUP BY 1, 2
  `;

  const whoopRows = await prisma().$queryRaw<WhoopMonthRow[]>`
    SELECT
      EXTRACT(YEAR FROM date)::int AS year,
      EXTRACT(MONTH FROM date)::int AS month,
      AVG("recoveryScore")::float AS "avgWhoopRecovery",
      AVG(strain)::float AS "avgWhoopStrain",
      AVG("hrvRmssdMs")::float AS "avgWhoopHrvMs",
      AVG("weightKg") FILTER (WHERE "weightKg" IS NOT NULL)::float AS "avgWhoopWeightKg",
      COUNT(*)::int AS "whoopDaysCount"
    FROM "DailyWhoopStat"
    WHERE "userId" = ${userId}
    GROUP BY 1, 2
  `;

  const stravaMap = new Map(
    stravaRows.map((r) => [`${r.year}-${r.month}`, r] as const),
  );
  const whoopMap = new Map(
    whoopRows.map((r) => [`${r.year}-${r.month}`, r] as const),
  );
  const keys = new Set([...stravaMap.keys(), ...whoopMap.keys()]);

  const records = [...keys].map((key) => {
    const [y, m] = key.split("-").map(Number);
    const s = stravaMap.get(key);
    const w = whoopMap.get(key);
    return {
      userId,
      year: y,
      month: m,
      runCount: s?.runCount ?? null,
      runDistanceMeters: s?.runDistanceMeters ?? null,
      runMovingTimeSec: s?.runMovingTimeSec ?? null,
      runElevGainM: s?.runElevGainM ?? null,
      avgPaceSecPerMi: s?.avgPaceSecPerMi ?? null,
      avgWhoopRecovery: w?.avgWhoopRecovery ?? null,
      avgWhoopStrain: w?.avgWhoopStrain ?? null,
      avgWhoopHrvMs: w?.avgWhoopHrvMs ?? null,
      whoopDaysCount: w?.whoopDaysCount ?? null,
      avgWhoopWeightKg: w?.avgWhoopWeightKg ?? null,
    };
  });

  await prisma().$transaction(async (tx) => {
    await tx.monthlyFitnessSnapshot.deleteMany({ where: { userId } });
    if (records.length > 0) {
      await tx.monthlyFitnessSnapshot.createMany({ data: records });
    }
  });
}
