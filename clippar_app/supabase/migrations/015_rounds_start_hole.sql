-- ============================================================================
-- 015 — Persist the round's starting hole (front vs back nine)
--
-- Live recording lets a user tee off on hole 1 (front / full round) or hole 10
-- (back nine). That choice was only ever held in app memory — nothing was
-- written to the rounds row — so a completed back-nine round could not be told
-- apart from a front-nine one, and round recovery always assumed hole 1. This
-- adds `start_hole` to rounds so the editor / scorecard render the real hole
-- numbers (10–18) and recovery restores the correct round shape.
--
-- Back-compatible: the column defaults to 1, so every existing round is
-- (correctly) treated as starting on hole 1. The CHECK also permits NULL as
-- defence in depth — the app always writes 1 or 10.
-- ============================================================================

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS start_hole INTEGER DEFAULT 1;

ALTER TABLE public.rounds
  ADD CONSTRAINT rounds_start_hole_valid
  CHECK (start_hole IS NULL OR start_hole IN (1, 10));

COMMENT ON COLUMN public.rounds.start_hole IS
  'Hole the round tees off on: 1 (front / full round) or 10 (back nine). '
  'Drives editor/scorecard hole numbering and round recovery. '
  'Default 1; existing rounds predate the column and are front/full rounds.';

-- ----------------------------------------------------------------------------
-- Column-level privilege — mirror the migration 013 pattern.
--
-- Migration 013 REVOKEd the blanket UPDATE grant on public.rounds from
-- `authenticated` and re-GRANTed UPDATE on an explicit column list (to fence
-- off the service-role-only `dispatch_claimed_at`). A NEW column added here is
-- therefore NOT in that grant, so without this statement the client could not
-- UPDATE start_hole.
--
-- The client sets start_hole at round creation via an INSERT
-- (lib/api.ts createRound), and 013 left the table-level INSERT grant intact —
-- so the value lands at creation without any INSERT grant change here. This
-- UPDATE grant is added so start_hole is on equal footing with the other
-- user-writable rounds columns (e.g. a future edit path can correct it), while
-- `dispatch_claimed_at` stays service-role-only.
-- ----------------------------------------------------------------------------
GRANT UPDATE (start_hole) ON public.rounds TO authenticated;
