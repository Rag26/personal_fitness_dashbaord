/**
 * Hevy public API client.
 *
 * Single-user personal app: the API key lives in `HEVY_API_KEY` (.env.local) —
 * no OAuth, no ConnectedAccount row. Hevy returns 401 if the key is missing or
 * revoked; surface that as a clear error so the Settings page can render it.
 *
 * API docs are minimal; field names below follow Hevy's OpenAPI spec
 * (https://api.hevyapp.com/docs).
 */

const HEVY_BASE_URL = "https://api.hevyapp.com";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function sanitizeEnvSecret(name: string) {
  const raw = requiredEnv(name);
  const value = raw.trim();
  if (value.includes("\n")) {
    throw new Error(`${name} contains a newline. Ensure it is on one line.`);
  }
  return value;
}

export function isHevyConfigured() {
  const raw = process.env.HEVY_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0;
}

type HevyFetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  searchParams?: Record<string, string | number | undefined>;
};

async function hevyFetch<T>(path: string, init: HevyFetchInit = {}): Promise<T> {
  const apiKey = sanitizeEnvSecret("HEVY_API_KEY");
  const url = new URL(path, HEVY_BASE_URL);
  if (init.searchParams) {
    for (const [k, v] of Object.entries(init.searchParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Hevy ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Types — pared down to the fields we actually consume. `rawPayload` on the
// DB row preserves anything else Hevy returns.
// ---------------------------------------------------------------------------

export type HevySet = {
  index?: number;
  type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
};

export type HevyExercise = {
  index?: number;
  title: string;
  exercise_template_id: string;
  superset_id?: number | null;
  notes?: string | null;
  sets: HevySet[];
};

export type HevyWorkoutResponse = {
  id: string;
  title: string;
  description?: string | null;
  start_time: string; // ISO 8601
  end_time: string;
  updated_at?: string;
  created_at?: string;
  exercises: HevyExercise[];
};

export type HevyPaginatedWorkouts = {
  page: number;
  page_count: number;
  workouts: HevyWorkoutResponse[];
};

export type HevyExerciseTemplateResponse = {
  id: string;
  title: string;
  type: string;
  primary_muscle_group: string;
  secondary_muscle_groups: string[];
  equipment?: string | null;
  is_custom: boolean;
};

export type HevyPaginatedExerciseTemplates = {
  page: number;
  page_count: number;
  exercise_templates: HevyExerciseTemplateResponse[];
};

export type HevyWorkoutEvent =
  | {
      type: "updated";
      workout: HevyWorkoutResponse;
    }
  | {
      type: "deleted";
      id: string;
      deleted_at: string;
    };

export type HevyPaginatedWorkoutEvents = {
  page: number;
  page_count: number;
  events: HevyWorkoutEvent[];
};

// ---------------------------------------------------------------------------
// Endpoint wrappers
// ---------------------------------------------------------------------------

export function listWorkouts(params: { page?: number; pageSize?: number } = {}) {
  return hevyFetch<HevyPaginatedWorkouts>("/v1/workouts", {
    searchParams: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
    },
  });
}

export function getWorkout(workoutId: string) {
  return hevyFetch<{ workout: HevyWorkoutResponse }>(
    `/v1/workouts/${encodeURIComponent(workoutId)}`,
  );
}

export function listWorkoutEvents(params: {
  since: string; // ISO 8601
  page?: number;
  pageSize?: number;
}) {
  return hevyFetch<HevyPaginatedWorkoutEvents>("/v1/workouts/events", {
    searchParams: {
      since: params.since,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
    },
  });
}

export function listExerciseTemplates(
  params: { page?: number; pageSize?: number } = {},
) {
  return hevyFetch<HevyPaginatedExerciseTemplates>("/v1/exercise_templates", {
    searchParams: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 100,
    },
  });
}

export function getExerciseTemplate(id: string) {
  return hevyFetch<HevyExerciseTemplateResponse>(
    `/v1/exercise_templates/${encodeURIComponent(id)}`,
  );
}
