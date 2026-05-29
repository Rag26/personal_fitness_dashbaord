-- Enable Row Level Security on the Hevy tables added in the prior migration.
-- Same pattern as the project's earlier RLS migrations: Prisma's superuser
-- connection bypasses RLS so app behavior is unchanged, but Supabase's
-- security advisor stops flagging these tables for clients hitting the
-- Postgres API directly.

ALTER TABLE "HevyWorkout"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HevyExerciseTemplate"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MuscleGroupWeeklyTarget" ENABLE ROW LEVEL SECURITY;
