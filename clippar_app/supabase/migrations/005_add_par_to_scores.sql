-- Add par column to scores table.
-- The app upserts par per hole when saving scores, but the column was missing.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS par INTEGER CHECK (par >= 3 AND par <= 6);

-- Backfill existing scores: compute par from the holes table where possible.
-- Postgres UPDATE...FROM cannot reference the target table in a JOIN, so use
-- a comma-separated FROM with conditions in WHERE.
UPDATE scores
SET par = h.par
FROM rounds r, holes h
WHERE scores.round_id = r.id
  AND h.course_id = r.course_id
  AND h.hole_number = scores.hole_number
  AND scores.par IS NULL
  AND r.course_id IS NOT NULL;

-- For scores without a linked course, default par to 4.
UPDATE scores SET par = 4 WHERE par IS NULL;
