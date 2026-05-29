-- Hevy integration: pulls lift workouts (with exercises + sets) from the Hevy
-- public API via HEVY_API_KEY (single-user personal app, so no ConnectedAccount
-- row). Adds the Provider enum value so SyncLog can log HEVY runs.

-- 1. Provider enum: add HEVY.
ALTER TYPE "Provider" ADD VALUE 'HEVY';

-- 2. User columns: sync cursors.
ALTER TABLE "User"
  ADD COLUMN "hevyLastSyncedAt"        TIMESTAMP(3),
  ADD COLUMN "hevyWorkoutEventsCursor" TIMESTAMP(3);

-- 3. MuscleGroupWeeklyTarget: per-muscle-group session targets (abs 3x, etc.).
CREATE TABLE "MuscleGroupWeeklyTarget" (
  "id"          TEXT         PRIMARY KEY,
  "userId"      TEXT         NOT NULL,
  "muscleGroup" TEXT         NOT NULL,
  "target"      INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MuscleGroupWeeklyTarget_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "MuscleGroupWeeklyTarget_userId_muscleGroup_key"
  ON "MuscleGroupWeeklyTarget" ("userId", "muscleGroup");

CREATE INDEX "MuscleGroupWeeklyTarget_userId_idx"
  ON "MuscleGroupWeeklyTarget" ("userId");

-- 4. HevyExerciseTemplate: cached lookup so workout sync can resolve exercises
--    to muscle groups without re-fetching the catalog.
CREATE TABLE "HevyExerciseTemplate" (
  "id"                    TEXT         PRIMARY KEY,
  "title"                 TEXT         NOT NULL,
  "type"                  TEXT         NOT NULL,
  "primaryMuscleGroup"    TEXT         NOT NULL,
  "secondaryMuscleGroups" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "equipment"             TEXT,
  "isCustom"              BOOLEAN      NOT NULL DEFAULT FALSE,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL
);

-- 5. HevyWorkout: synced workouts with exercise/set details.
CREATE TABLE "HevyWorkout" (
  "id"                      TEXT         PRIMARY KEY,
  "userId"                  TEXT         NOT NULL,
  "providerWorkoutId"       TEXT         NOT NULL,
  "title"                   TEXT         NOT NULL,
  "description"             TEXT,
  "startAt"                 TIMESTAMP(3) NOT NULL,
  "endAt"                   TIMESTAMP(3) NOT NULL,
  "liftSessionTemplate"     "LiftSessionTemplate",
  "liftSessionTemplateAuto" BOOLEAN      NOT NULL DEFAULT TRUE,
  "exercises"               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "muscleGroups"            TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rawPayload"              JSONB,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HevyWorkout_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "HevyWorkout_userId_providerWorkoutId_key"
  ON "HevyWorkout" ("userId", "providerWorkoutId");

CREATE INDEX "HevyWorkout_userId_startAt_idx"
  ON "HevyWorkout" ("userId", "startAt");

CREATE INDEX "HevyWorkout_userId_liftSessionTemplate_idx"
  ON "HevyWorkout" ("userId", "liftSessionTemplate");

CREATE INDEX "HevyWorkout_startAt_idx"
  ON "HevyWorkout" ("startAt");
