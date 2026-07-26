-- Ratings are computed at full precision and stored rounded to two decimal places
-- (ADR 0047). The column enforces it, rather than trusting every write path to
-- remember to round.
--
-- Lossless here: every existing value is a whole number (the 1000 default), so the
-- cast changes no data. Verified before writing this, not assumed.
ALTER TABLE "Task" ALTER COLUMN "rating" SET DATA TYPE DECIMAL(12,2);
