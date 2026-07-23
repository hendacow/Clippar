-- ============================
-- COURSE PRESET PER-HOLE PARS (Custom scorecard bookmarks)
-- ============================
-- Users can't trust the golf-course API's par data. This adds an optional
-- per-hole par array to a preset so a user can SAVE a course's scorecard by
-- choosing the par of each hole themselves. When a round is started from a
-- preset that carries `hole_pars`, those values OVERRIDE whatever the golf
-- course API returned and drive the overlaid scorecard + total_par /
-- score_to_par.
--
--   • hole_pars is POSITIONAL: element i (0-based) is the par of the i-th
--     hole played. For the common case (start_hole = 1) that means
--     hole number N → hole_pars[N-1]. For a 9-hole back-nine preset
--     (start_hole = 10) element 0 maps to hole 10, element 8 to hole 18.
--   • Length equals holes_played (9 or 18). The app writes exactly that;
--     the DB constraint keeps it in a sane 1..18 range as defence in depth.
--   • Each element is a real par. The par-entry UI only offers 3/4/5, but
--     we allow 3..6 so an unusual par-6 hole (or future UI) still saves.
--
-- Nullable so every existing preset (which has no per-hole pars) keeps
-- working untouched: those rows simply fall back to the API / seeded par.
-- RLS, indexes and the updated_at trigger from 009 already cover this
-- column — nothing to re-declare.

ALTER TABLE course_presets
  ADD COLUMN hole_pars INTEGER[];

-- Validate the array without a trigger: right length band, no NULL holes,
-- every element a plausible par. `3 <= ALL (hole_pars)` means "every element
-- is >= 3"; `6 >= ALL (hole_pars)` means "every element is <= 6". The
-- array_position(..., NULL) guard rejects a sparse array, since ALL() would
-- otherwise short-circuit to NULL (and pass) on a NULL element.
ALTER TABLE course_presets
  ADD CONSTRAINT course_presets_hole_pars_valid CHECK (
    hole_pars IS NULL OR (
      array_length(hole_pars, 1) BETWEEN 1 AND 18
      AND array_position(hole_pars, NULL) IS NULL
      AND 3 <= ALL (hole_pars)
      AND 6 >= ALL (hole_pars)
    )
  );

COMMENT ON COLUMN course_presets.hole_pars IS
  'Optional user-chosen per-hole par (positional, length = holes_played). '
  'Overrides the golf-course API par for rounds started from this preset. '
  'NULL = no custom scorecard; fall back to API / seeded par.';
