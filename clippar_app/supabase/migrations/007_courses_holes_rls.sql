-- RLS policies for courses + holes write paths.
--
-- Migration 001 only created SELECT policies for courses and holes, which
-- means any client-side INSERT or UPDATE from `lib/api.ts` (e.g.
-- upsertCourseFromLiveApi when the user picks a course not yet in our
-- seed list) fails with "new row violates row-level security policy".
--
-- Allow authenticated users to insert and update both tables. Course
-- data is community-curated and the cost of a bad write is low; user
-- data (rounds, scores, shots) remains gated by ownership policies.

-- Drop-then-create so prod (which may already have these policies added
-- via the dashboard) doesn't error on re-apply.

-- Courses
DROP POLICY IF EXISTS "Authenticated users can insert courses" ON courses;
CREATE POLICY "Authenticated users can insert courses"
  ON courses FOR INSERT TO authenticated WITH CHECK (TRUE);

DROP POLICY IF EXISTS "Authenticated users can update courses" ON courses;
CREATE POLICY "Authenticated users can update courses"
  ON courses FOR UPDATE TO authenticated USING (TRUE) WITH CHECK (TRUE);

-- Holes (per-course par/yardage rows)
DROP POLICY IF EXISTS "Authenticated users can insert holes" ON holes;
CREATE POLICY "Authenticated users can insert holes"
  ON holes FOR INSERT TO authenticated WITH CHECK (TRUE);

DROP POLICY IF EXISTS "Authenticated users can update holes" ON holes;
CREATE POLICY "Authenticated users can update holes"
  ON holes FOR UPDATE TO authenticated USING (TRUE) WITH CHECK (TRUE);
