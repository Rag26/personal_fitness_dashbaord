-- Drop all Fitbit support from the schema.
-- Safe to run on a fresh DB or on a DB that contains Fitbit rows: rows are
-- deleted explicitly before the enum value is removed so the cast succeeds.

-- 1. Delete OAuth rows tied to FITBIT so the enum value has no remaining usage.
DELETE FROM "ConnectedAccount" WHERE "provider" = 'FITBIT';
DELETE FROM "SyncLog"          WHERE "provider" = 'FITBIT';

-- 2. Drop the FK constraint + column on DerivedDailyMetric BEFORE the referenced table is dropped
--    (otherwise Postgres refuses to drop DailyFitbitStat with code 2BP01).
ALTER TABLE "DerivedDailyMetric" DROP CONSTRAINT IF EXISTS "DerivedDailyMetric_sourceFitbitStatId_fkey";
ALTER TABLE "DerivedDailyMetric" DROP COLUMN IF EXISTS "sourceFitbitStatId";

-- 3. Drop the Fitbit-only tables.
DROP TABLE IF EXISTS "FitbitActivityLog";
DROP TABLE IF EXISTS "DailyFitbitStat";

-- 4. Drop the Fitbit-sourced columns on MonthlyFitnessSnapshot (they are recomputable rollups).
ALTER TABLE "MonthlyFitnessSnapshot" DROP COLUMN IF EXISTS "avgSteps";
ALTER TABLE "MonthlyFitnessSnapshot" DROP COLUMN IF EXISTS "avgSleepMinutes";
ALTER TABLE "MonthlyFitnessSnapshot" DROP COLUMN IF EXISTS "avgRestingHr";
ALTER TABLE "MonthlyFitnessSnapshot" DROP COLUMN IF EXISTS "avgWeightKg";
ALTER TABLE "MonthlyFitnessSnapshot" DROP COLUMN IF EXISTS "fitbitDaysCount";

-- 5. Remove FITBIT from the Provider enum. Postgres can't ALTER TYPE ... DROP VALUE,
--    so swap the enum: create new, recast columns, drop old.
ALTER TYPE "Provider" RENAME TO "Provider_old";
CREATE TYPE "Provider" AS ENUM ('STRAVA', 'WHOOP');
ALTER TABLE "ConnectedAccount" ALTER COLUMN "provider" TYPE "Provider" USING "provider"::text::"Provider";
ALTER TABLE "SyncLog"          ALTER COLUMN "provider" TYPE "Provider" USING "provider"::text::"Provider";
DROP TYPE "Provider_old";
