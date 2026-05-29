-- Full-day WHOOP energy expenditure (kcal) on the daily stat row.
-- Source = cycle score.kilojoule ÷ 4.184. Nullable; backfilled by a WHOOP
-- deep re-sync. Additive, zero-downtime — no existing rows touched.
ALTER TABLE "DailyWhoopStat" ADD COLUMN "energyKcal" DOUBLE PRECISION;
