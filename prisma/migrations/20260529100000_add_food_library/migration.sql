-- Personal food library (label-photo driven). Replaces the dead Nutritionix
-- lookup as the primary food-data source: each item is captured once (usually
-- by photographing a nutrition label, parsed by Claude vision) and re-logged
-- by selecting it + entering grams.
--
-- Additive and safe to apply zero-downtime; no existing tables are touched.

CREATE TABLE "FoodLibraryItem" (
  "id"           TEXT             PRIMARY KEY,
  "userId"       TEXT             NOT NULL,
  "name"         TEXT             NOT NULL,
  "servingLabel" TEXT,
  "servingGrams" DOUBLE PRECISION,
  "caloriesKcal" DOUBLE PRECISION NOT NULL,
  "proteinG"     DOUBLE PRECISION NOT NULL,
  "carbsG"       DOUBLE PRECISION NOT NULL,
  "fatG"         DOUBLE PRECISION NOT NULL,
  "createdAt"    TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "FoodLibraryItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

-- One library entry per name per user; re-scanning a label updates the row.
CREATE UNIQUE INDEX "FoodLibraryItem_userId_name_key"
  ON "FoodLibraryItem" ("userId", "name");
CREATE INDEX "FoodLibraryItem_userId_createdAt_idx"
  ON "FoodLibraryItem" ("userId", "createdAt");

-- RLS: same pattern as the other user-scoped tables. Prisma's superuser bypasses
-- RLS so app behavior is unchanged; Supabase's security advisor stops flagging.
ALTER TABLE "FoodLibraryItem" ENABLE ROW LEVEL SECURITY;
