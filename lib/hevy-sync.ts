import { prisma } from "@/lib/db";
import {
  getExerciseTemplate,
  getWorkout,
  listExerciseTemplates,
  listWorkoutEvents,
  listWorkouts,
  type HevyExerciseTemplateResponse,
  type HevyWorkoutResponse,
} from "@/lib/hevy";
import {
  classifyLiftSession,
  expandWorkoutMuscleGroups,
} from "@/lib/hevy-muscle-groups";

const HEVY_PAGE_SIZE = 10; // Hevy caps /v1/workouts at 10 per page.
const HEVY_TEMPLATES_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Exercise template cache
// ---------------------------------------------------------------------------

/**
 * Walks /v1/exercise_templates and upserts every row into HevyExerciseTemplate.
 * Cheap to re-run (Hevy returns paginated lists, no need for cursors). Run on
 * first sync, when a workout references an unknown exercise, or on demand from
 * Settings.
 */
export async function syncHevyExerciseTemplates(): Promise<{
  fetched: number;
  upserted: number;
}> {
  let page = 1;
  let totalPages = 1;
  let fetched = 0;
  let upserted = 0;

  while (page <= totalPages) {
    const res = await listExerciseTemplates({
      page,
      pageSize: HEVY_TEMPLATES_PAGE_SIZE,
    });
    totalPages = res.page_count || 1;
    for (const t of res.exercise_templates) {
      fetched += 1;
      await upsertExerciseTemplate(t);
      upserted += 1;
    }
    page += 1;
    if (res.exercise_templates.length === 0) break;
  }

  return { fetched, upserted };
}

async function upsertExerciseTemplate(t: HevyExerciseTemplateResponse) {
  await prisma().hevyExerciseTemplate.upsert({
    where: { id: t.id },
    create: {
      id: t.id,
      title: t.title,
      type: t.type,
      primaryMuscleGroup: t.primary_muscle_group.toLowerCase(),
      secondaryMuscleGroups: (t.secondary_muscle_groups ?? []).map((s) =>
        s.toLowerCase(),
      ),
      equipment: t.equipment ?? null,
      isCustom: Boolean(t.is_custom),
    },
    update: {
      title: t.title,
      type: t.type,
      primaryMuscleGroup: t.primary_muscle_group.toLowerCase(),
      secondaryMuscleGroups: (t.secondary_muscle_groups ?? []).map((s) =>
        s.toLowerCase(),
      ),
      equipment: t.equipment ?? null,
      isCustom: Boolean(t.is_custom),
    },
  });
}

/**
 * Fetch a template that the workout sync referenced but isn't yet cached. We
 * write the row through immediately so subsequent exercises in the same workout
 * don't re-fetch the same template.
 */
async function fetchAndCacheTemplate(
  id: string,
): Promise<HevyExerciseTemplateResponse | null> {
  try {
    const t = await getExerciseTemplate(id);
    await upsertExerciseTemplate(t);
    return t;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workout sync
// ---------------------------------------------------------------------------

type ExerciseStored = {
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

async function buildExerciseRows(
  workout: HevyWorkoutResponse,
  templateCache: Map<string, HevyExerciseTemplateResponse | null>,
): Promise<ExerciseStored[]> {
  // Resolve any templates not yet in the cache (single round-trip per miss).
  const missing = new Set<string>();
  for (const ex of workout.exercises) {
    if (!templateCache.has(ex.exercise_template_id)) {
      missing.add(ex.exercise_template_id);
    }
  }
  if (missing.size > 0) {
    const cached = await prisma().hevyExerciseTemplate.findMany({
      where: { id: { in: Array.from(missing) } },
    });
    for (const row of cached) {
      templateCache.set(row.id, {
        id: row.id,
        title: row.title,
        type: row.type,
        primary_muscle_group: row.primaryMuscleGroup,
        secondary_muscle_groups: row.secondaryMuscleGroups,
        equipment: row.equipment,
        is_custom: row.isCustom,
      });
      missing.delete(row.id);
    }
  }
  for (const id of missing) {
    const fetched = await fetchAndCacheTemplate(id);
    templateCache.set(id, fetched);
  }

  return workout.exercises.map((ex, idx) => {
    const template = templateCache.get(ex.exercise_template_id) ?? null;
    return {
      index: ex.index ?? idx,
      exerciseTemplateId: ex.exercise_template_id,
      title: ex.title,
      primaryMuscleGroup: template?.primary_muscle_group.toLowerCase() ?? "",
      secondaryMuscleGroups: (template?.secondary_muscle_groups ?? []).map(
        (s) => s.toLowerCase(),
      ),
      notes: ex.notes ?? null,
      sets: ex.sets.map((s, sIdx) => ({
        index: s.index ?? sIdx,
        type: s.type ?? null,
        reps: s.reps ?? null,
        weightKg: s.weight_kg ?? null,
        distanceMeters: s.distance_meters ?? null,
        durationSeconds: s.duration_seconds ?? null,
        rpe: s.rpe ?? null,
      })),
    };
  });
}

async function upsertWorkout(
  userId: string,
  workout: HevyWorkoutResponse,
  templateCache: Map<string, HevyExerciseTemplateResponse | null>,
) {
  const exerciseRows = await buildExerciseRows(workout, templateCache);
  const muscleGroups = expandWorkoutMuscleGroups(exerciseRows);
  const autoTemplate = classifyLiftSession(exerciseRows);

  // Preserve a user override: if the existing row was marked manual, keep its
  // liftSessionTemplate and leave the auto flag alone.
  const existing = await prisma().hevyWorkout.findUnique({
    where: {
      userId_providerWorkoutId: {
        userId,
        providerWorkoutId: workout.id,
      },
    },
    select: { liftSessionTemplate: true, liftSessionTemplateAuto: true },
  });

  const keepUserOverride =
    existing != null && existing.liftSessionTemplateAuto === false;

  const base = {
    userId,
    providerWorkoutId: workout.id,
    title: workout.title,
    description: workout.description ?? null,
    startAt: new Date(workout.start_time),
    endAt: new Date(workout.end_time),
    exercises: exerciseRows as unknown as object,
    muscleGroups,
    rawPayload: workout as unknown as object,
  };

  await prisma().hevyWorkout.upsert({
    where: {
      userId_providerWorkoutId: {
        userId,
        providerWorkoutId: workout.id,
      },
    },
    create: {
      ...base,
      liftSessionTemplate: autoTemplate,
      liftSessionTemplateAuto: true,
    },
    update: keepUserOverride
      ? base
      : {
          ...base,
          liftSessionTemplate: autoTemplate,
          liftSessionTemplateAuto: true,
        },
  });
}

export type HevySyncResult = {
  ok: true;
  fetched: number;
  upserted: number;
  pages: number;
  oldestStartAt: string | null;
};

/**
 * Deep sync: paginate /v1/workouts newest→oldest, stop once we've crossed the
 * `days` window or run out of pages. Writes through HevyWorkout, populates the
 * template cache as needed, updates User.hevyLastSyncedAt + the events cursor.
 *
 * Wrap with `withSyncLog()` for SyncLog tracking.
 */
export async function syncHevyWorkouts({
  userId,
  days,
}: {
  userId: string;
  days: number;
}): Promise<HevySyncResult> {
  const windowEnd = Date.now();
  const windowStart = windowEnd - days * 24 * 60 * 60 * 1000;

  const templateCache = new Map<string, HevyExerciseTemplateResponse | null>();
  let fetched = 0;
  let upserted = 0;
  let page = 1;
  let totalPages = 1;
  let oldestStartAt: Date | null = null;
  let pastWindow = false;

  while (page <= totalPages && !pastWindow) {
    const res = await listWorkouts({ page, pageSize: HEVY_PAGE_SIZE });
    totalPages = res.page_count || 1;
    if (res.workouts.length === 0) break;

    for (const w of res.workouts) {
      fetched += 1;
      const startMs = new Date(w.start_time).getTime();
      if (!Number.isFinite(startMs)) continue;
      if (startMs < windowStart) {
        pastWindow = true;
        break;
      }
      await upsertWorkout(userId, w, templateCache);
      upserted += 1;
      const startDate = new Date(startMs);
      if (oldestStartAt === null || startDate < oldestStartAt) {
        oldestStartAt = startDate;
      }
    }
    page += 1;
  }

  const now = new Date();
  await prisma().user.update({
    where: { id: userId },
    data: {
      hevyLastSyncedAt: now,
      hevyWorkoutEventsCursor: now,
    },
  });

  return {
    ok: true,
    fetched,
    upserted,
    pages: page - 1,
    oldestStartAt: oldestStartAt?.toISOString() ?? null,
  };
}

/**
 * Incremental sync via /v1/workouts/events. Cheaper than a deep paginate: uses
 * User.hevyWorkoutEventsCursor as `since`, applies updates + deletes, advances
 * the cursor. Falls back to a 7-day deep sync if no cursor is set yet.
 */
export async function syncHevyWorkoutEvents({
  userId,
}: {
  userId: string;
}): Promise<{
  ok: true;
  updated: number;
  deleted: number;
  pages: number;
}> {
  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { hevyWorkoutEventsCursor: true },
  });
  const since = user?.hevyWorkoutEventsCursor ?? null;
  if (!since) {
    const deep = await syncHevyWorkouts({ userId, days: 7 });
    return {
      ok: true,
      updated: deep.upserted,
      deleted: 0,
      pages: deep.pages,
    };
  }

  const templateCache = new Map<string, HevyExerciseTemplateResponse | null>();
  let updated = 0;
  let deleted = 0;
  let page = 1;
  let totalPages = 1;
  let maxEventAt: Date | null = null;

  while (page <= totalPages) {
    const res = await listWorkoutEvents({
      since: since.toISOString(),
      page,
      pageSize: HEVY_PAGE_SIZE,
    });
    totalPages = res.page_count || 1;
    if (res.events.length === 0) break;

    for (const ev of res.events) {
      if (ev.type === "deleted") {
        await prisma()
          .hevyWorkout.deleteMany({
            where: { userId, providerWorkoutId: ev.id },
          })
          .catch(() => {});
        deleted += 1;
        const at = new Date(ev.deleted_at);
        if (Number.isFinite(at.getTime())) {
          if (maxEventAt === null || at > maxEventAt) maxEventAt = at;
        }
      } else {
        await upsertWorkout(userId, ev.workout, templateCache);
        updated += 1;
        const at = new Date(ev.workout.updated_at ?? ev.workout.start_time);
        if (Number.isFinite(at.getTime())) {
          if (maxEventAt === null || at > maxEventAt) maxEventAt = at;
        }
      }
    }
    page += 1;
  }

  const now = new Date();
  await prisma().user.update({
    where: { id: userId },
    data: {
      hevyLastSyncedAt: now,
      hevyWorkoutEventsCursor: maxEventAt ?? now,
    },
  });

  return { ok: true, updated, deleted, pages: page - 1 };
}

/**
 * Pull a single workout by id (used by the webhook handler) and upsert it.
 * Returns the upserted row's startAt so the caller can advance any cursors.
 */
export async function syncSingleHevyWorkout({
  userId,
  workoutId,
}: {
  userId: string;
  workoutId: string;
}): Promise<{ ok: true; startAt: string } | { ok: false; error: string }> {
  try {
    const res = await getWorkout(workoutId);
    const templateCache = new Map<
      string,
      HevyExerciseTemplateResponse | null
    >();
    await upsertWorkout(userId, res.workout, templateCache);
    const now = new Date();
    await prisma().user.update({
      where: { id: userId },
      data: { hevyLastSyncedAt: now },
    });
    return { ok: true, startAt: res.workout.start_time };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// SyncLog wrappers — match the WHOOP pattern so the audit table is consistent.
// ---------------------------------------------------------------------------

export type HevySyncWithLogResult =
  | {
      ok: true;
      fetched: number;
      upserted: number;
      pages: number;
      templatesFetched?: number;
    }
  | { ok: false; error: string };

export async function syncHevyDeepWithLog({
  userId,
  days,
  refreshTemplates = false,
}: {
  userId: string;
  days: number;
  refreshTemplates?: boolean;
}): Promise<HevySyncWithLogResult> {
  const startedAt = new Date();
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - days * 24 * 60 * 60 * 1000,
  );

  const syncLog = await prisma().syncLog.create({
    data: {
      userId,
      provider: "HEVY",
      status: "PARTIAL",
      startedAt,
      windowStartAt: windowStart,
      windowEndAt: windowEnd,
      fetchedCount: 0,
      upsertedCount: 0,
    },
    select: { id: true },
  });

  try {
    let templatesFetched = 0;
    if (refreshTemplates) {
      const t = await syncHevyExerciseTemplates();
      templatesFetched = t.upserted;
    } else {
      // Auto-populate on first sync.
      const count = await prisma().hevyExerciseTemplate.count();
      if (count === 0) {
        const t = await syncHevyExerciseTemplates();
        templatesFetched = t.upserted;
      }
    }
    const result = await syncHevyWorkouts({ userId, days });
    await prisma().syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        fetchedCount: result.fetched,
        upsertedCount: result.upserted,
      },
    });
    return {
      ok: true,
      fetched: result.fetched,
      upserted: result.upserted,
      pages: result.pages,
      templatesFetched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma().syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
    return { ok: false, error: message };
  }
}

export async function syncHevyEventsWithLog({
  userId,
}: {
  userId: string;
}): Promise<
  | { ok: true; updated: number; deleted: number; pages: number }
  | { ok: false; error: string }
> {
  const startedAt = new Date();
  const syncLog = await prisma().syncLog.create({
    data: {
      userId,
      provider: "HEVY",
      status: "PARTIAL",
      startedAt,
      fetchedCount: 0,
      upsertedCount: 0,
    },
    select: { id: true },
  });

  try {
    const result = await syncHevyWorkoutEvents({ userId });
    await prisma().syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        fetchedCount: result.updated + result.deleted,
        upsertedCount: result.updated,
      },
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma().syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
    return { ok: false, error: message };
  }
}
