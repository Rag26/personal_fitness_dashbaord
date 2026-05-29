-- Weight-loss-driven nutrition coach (Phase 1): adds three tables.
--   WeightGoal       — active weight-management goal (target + deadline) +
--                      week-by-week intake history + macro overrides.
--   FoodLogEntry     — per-food MANUAL nutrition log (replaces the previous
--                      per-day-totals form). Daily totals are SUM-aggregated.
--   CachedFoodLookup — Nutritionix /v2/natural/nutrients responses, cached
--                      indefinitely (food nutrition is static).
--
-- All three are additive and safe to apply zero-downtime. The existing
-- DailyNutritionLog table is unchanged; it remains the BACKFILL-only table
-- for Apple Health imports.

-- 1. WeightGoal: active goal + weekly intake target history.
CREATE TABLE "WeightGoal" (
  "id"                       TEXT         PRIMARY KEY,
  "userId"                   TEXT         NOT NULL,
  "targetWeightLb"           DOUBLE PRECISION NOT NULL,
  "deadlineDate"             TIMESTAMP(3) NOT NULL,
  "startWeightLb"            DOUBLE PRECISION NOT NULL,
  "startedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive"                 BOOLEAN      NOT NULL DEFAULT TRUE,
  "lastRecalibratedIsoWeek"  TEXT,
  "intakeHistory"            JSONB        NOT NULL,
  "macroOverrides"           JSONB,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WeightGoal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "WeightGoal_userId_isActive_idx"
  ON "WeightGoal" ("userId", "isActive");
CREATE INDEX "WeightGoal_userId_startedAt_idx"
  ON "WeightGoal" ("userId", "startedAt");

-- 2. CachedFoodLookup: created BEFORE FoodLogEntry because FoodLogEntry has
--    a SET NULL foreign key into it.
CREATE TABLE "CachedFoodLookup" (
  "id"              TEXT             PRIMARY KEY,
  "queryNormalized" TEXT             NOT NULL,
  "responseJson"    JSONB            NOT NULL,
  "caloriesKcal"    DOUBLE PRECISION NOT NULL,
  "proteinG"        DOUBLE PRECISION NOT NULL,
  "fatG"            DOUBLE PRECISION NOT NULL,
  "carbsG"          DOUBLE PRECISION NOT NULL,
  "servingLabel"    TEXT             NOT NULL,
  "hitCount"        INTEGER          NOT NULL DEFAULT 1,
  "createdAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "CachedFoodLookup_queryNormalized_key"
  ON "CachedFoodLookup" ("queryNormalized");
CREATE INDEX "CachedFoodLookup_lastUsedAt_idx"
  ON "CachedFoodLookup" ("lastUsedAt");

-- 3. FoodLogEntry: per-food MANUAL log.
CREATE TABLE "FoodLogEntry" (
  "id"                 TEXT             PRIMARY KEY,
  "userId"             TEXT             NOT NULL,
  "date"               TIMESTAMP(3)     NOT NULL,
  "loggedAt"           TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mealTime"           TEXT,
  "foodName"           TEXT             NOT NULL,
  "servingLabel"       TEXT,
  "caloriesKcal"       DOUBLE PRECISION NOT NULL,
  "proteinG"           DOUBLE PRECISION NOT NULL,
  "carbsG"             DOUBLE PRECISION NOT NULL,
  "fatG"               DOUBLE PRECISION NOT NULL,
  "cachedFoodLookupId" TEXT,
  "createdAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "FoodLogEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "FoodLogEntry_cachedFoodLookupId_fkey"
    FOREIGN KEY ("cachedFoodLookupId") REFERENCES "CachedFoodLookup"("id") ON DELETE SET NULL
);

CREATE INDEX "FoodLogEntry_userId_date_idx"
  ON "FoodLogEntry" ("userId", "date");
CREATE INDEX "FoodLogEntry_userId_loggedAt_idx"
  ON "FoodLogEntry" ("userId", "loggedAt");
CREATE INDEX "FoodLogEntry_userId_foodName_loggedAt_idx"
  ON "FoodLogEntry" ("userId", "foodName", "loggedAt");

-- 4. RLS: enable on the three new tables. Same pattern as
--    20260519220500_enable_rls_hevy — Prisma's superuser bypasses RLS so app
--    behavior is unchanged, but Supabase's security advisor stops flagging.
ALTER TABLE "WeightGoal"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FoodLogEntry"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CachedFoodLookup" ENABLE ROW LEVEL SECURITY;
