-- ============================
-- COURSE PRESETS (Wave 3)
-- ============================
-- A preset captures the per-round setup choices the user makes for a given
-- course so they can skip the setup screens on repeat visits:
--   • which course they played
--   • how many holes (9 or 18)
--   • which hole they teed off on (1 or 10)
--   • how long each clip should be trimmed to (overrides the global default)
--
-- Presets are user-owned. RLS limits SELECT/INSERT/UPDATE/DELETE to the
-- owner. course_id is a soft reference — if a course is deleted from
-- our catalogue the preset survives with course_name as the fallback
-- (sets course_id to NULL on delete rather than cascading the row away,
-- so the user doesn't lose presets when we clean up the courses table).

CREATE TABLE course_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,

  -- Course identity. We store BOTH the FK and the snapshot name so the
  -- preset still renders sensibly if the course is later removed.
  course_id UUID REFERENCES courses ON DELETE SET NULL,
  course_name TEXT NOT NULL,

  -- Round structure
  holes_played INTEGER NOT NULL CHECK (holes_played IN (9, 18)),
  start_hole   INTEGER NOT NULL CHECK (start_hole   IN (1, 10)),

  -- Trim duration in milliseconds for each clip on this preset's rounds.
  -- Optional: NULL means use the user's / app default. Range matches the
  -- in-app slider in config.yaml (4s–6s) plus a bit of headroom.
  trim_duration_ms INTEGER CHECK (
    trim_duration_ms IS NULL OR (trim_duration_ms BETWEEN 1000 AND 15000)
  ),

  -- Display name shown in the preset picker. Falls back to the course
  -- name + holes count if the user doesn't type one.
  name TEXT NOT NULL,

  -- Used to sort the picker so the most-recently-used preset shows first.
  -- NOT NULL enforces the invariant the TS types and the picker query rely
  -- on (the ORDER BY last_used_at would otherwise need a NULLS LAST clause
  -- and the type would have to widen to `string | null`).
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A user shouldn't be able to create two presets with the exact same
  -- name. Easier to scan in the picker and avoids confusion.
  CONSTRAINT course_presets_unique_name_per_user UNIQUE (user_id, name)
);

-- Faster picker queries: list current user's presets, newest first.
CREATE INDEX idx_course_presets_user_recent
  ON course_presets (user_id, last_used_at DESC);

-- ============================
-- RLS
-- ============================
ALTER TABLE course_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own presets"
  ON course_presets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own presets"
  ON course_presets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own presets"
  ON course_presets FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own presets"
  ON course_presets FOR DELETE
  USING (auth.uid() = user_id);

-- ============================
-- updated_at trigger
-- ============================
-- Mirrors the pattern other tables use. Keeps updated_at honest without
-- requiring client cooperation.
CREATE OR REPLACE FUNCTION touch_course_presets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER course_presets_updated_at
  BEFORE UPDATE ON course_presets
  FOR EACH ROW EXECUTE FUNCTION touch_course_presets_updated_at();

COMMENT ON TABLE course_presets IS
  'User-defined shortcuts that pre-fill the round setup screens. Wave 3.';
