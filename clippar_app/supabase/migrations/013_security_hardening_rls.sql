-- ============================================================================
-- 013 — Security hardening for RLS / privilege escalation surfaces
--
-- Closes three confirmed findings from the full-app security audit. All three
-- are pure RLS / grant changes; no data is modified. Service-role access
-- (Edge Functions, webhooks) is unaffected — the service role bypasses RLS and
-- keeps its own table grants, so revenuecat-webhook / stripe-webhook /
-- sync-courses continue to write these columns/tables normally.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- FINDING (critical/high): Free users can self-grant Pro by writing the
-- privileged billing columns on their own profile row.
--
-- The "Users can update own profile" policy (001) is `USING (auth.uid() = id)`
-- with no WITH CHECK and no column scoping, and `authenticated` holds the
-- default table-wide UPDATE grant. That lets any user write EVERY column of
-- their own row — including `subscription_status` / `subscription_expires_at`,
-- which lib/subscription.ts treats as authoritative proof of a Pro entitlement.
--
-- RLS cannot express column-level write rules, so we enforce them with
-- PostgreSQL column-level privileges: revoke the blanket UPDATE grant and
-- re-grant UPDATE only on the non-privileged, user-owned columns. The RLS row
-- policy still restricts writes to the user's own row; the column grant now
-- also restricts WHICH columns they may write. Billing columns become writable
-- only by the service role (RevenueCat / Stripe webhooks).
--
-- Client no-op note: lib/subscription.ts fires an optimistic
-- `.update({ subscription_status: 'expired' })`. That write now returns a
-- permission error, which the client ignores (result is discarded and the
-- entitlement is recomputed as false anyway), so behaviour is unchanged.
-- ----------------------------------------------------------------------------
REVOKE UPDATE ON public.profiles FROM anon, authenticated;

GRANT UPDATE (
  display_name,
  email,
  handicap,
  home_course,
  avatar_url,
  ble_device_id,
  expo_push_token,
  updated_at
) ON public.profiles TO authenticated;


-- ----------------------------------------------------------------------------
-- FINDING (high): Anon key can enumerate every user's published rounds and
-- harvest all share tokens + reel URLs in bulk.
--
-- The "Shared rounds are publicly viewable" policy (001) has no `TO` clause, so
-- it applies to the anon role and exposes the entire published-rounds row set
-- (share_token, reel_url, user_id, notes, scores, …) over PostgREST with only
-- the public anon key. The intended public-share path is the service-role
-- `get-shared-reel` Edge Function, which looks a round up by one exact token
-- and never distinguishes missing/unpublished tokens — so it can't be probed.
--
-- This RLS policy is redundant with that function (the function runs as the
-- service role and re-checks `share_token IS NOT NULL AND is_published = TRUE`
-- itself) and is the sole thing enabling bulk enumeration. Drop it. Owners
-- still read their own rounds via "Users can manage own rounds".
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Shared rounds are publicly viewable" ON public.rounds;


-- ----------------------------------------------------------------------------
-- FINDING (medium): Any authenticated user can overwrite the global
-- courses/holes catalog.
--
-- Migration 007 granted authenticated users UPDATE on the shared `courses` and
-- `holes` reference tables with `USING (TRUE) WITH CHECK (TRUE)` — no ownership
-- scoping — so any single account can rewrite any course name / par for every
-- user, corrupting score-to-par for the whole user base.
--
-- Drop the two UPDATE policies. Authenticated users keep INSERT (adding a
-- genuinely new course during a round is a legitimate flow), but can no longer
-- mutate existing shared rows. The service-role `sync-courses` Edge Function
-- (which bypasses RLS) remains the authoritative writer/enricher.
--
-- Client graceful-degradation note: lib/api.ts `upsertCourseFromLiveApi`
-- attempts to UPDATE an already-cached course; that UPDATE now returns no row
-- and the code falls back to the existing row (`updated || courseRow`). Its
-- per-hole `.upsert(...ON CONFLICT)` still INSERTs brand-new holes (INSERT is
-- still permitted); only the update-on-conflict branch for already-present
-- holes is denied, which is ignored.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can update courses" ON public.courses;
DROP POLICY IF EXISTS "Authenticated users can update holes" ON public.holes;


-- ----------------------------------------------------------------------------
-- FINDING (medium): process-round compute-bill DoS via a client-forgeable
-- claim guard.
--
-- process-round dispatches a ~14-min Modal GPU job. Its original guard claimed
-- the round by transitioning `status` (recording/uploading/failed → processing)
-- and rejecting when zero rows matched. But `status` is client-writable — the
-- "Users can manage own rounds" FOR ALL policy plus the table-wide UPDATE grant
-- let any owner rewrite it, and the app legitimately does (hooks/useRound.ts,
-- app/round/import.tsx, app/round/editor.tsx). An attacker could therefore
-- reset `status` back to a claimable value and loop the endpoint, launching a
-- fresh GPU job every time.
--
-- We cannot simply strip `status` from the client grant — the app depends on
-- writing it. Instead we add a dedicated service-role-only claim stamp,
-- `dispatch_claimed_at`, that the client cannot write. process-round claims a
-- round with an atomic `UPDATE ... WHERE dispatch_claimed_at IS NULL` and
-- rejects (409) when no row returns; because the column is excluded from the
-- client UPDATE grant, a user cannot reset it to re-arm the claim.
--
-- Postgres has no "grant every column except one", so we mirror the profiles
-- fix: revoke the blanket UPDATE grant and re-grant UPDATE on every existing
-- rounds column EXCEPT `dispatch_claimed_at`. `status` stays in the list, so
-- all legitimate client status writes keep working unchanged.
-- ----------------------------------------------------------------------------
ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at TIMESTAMPTZ;

REVOKE UPDATE ON public.rounds FROM anon, authenticated;

GRANT UPDATE (
  id,
  user_id,
  course_id,
  course_name,
  date,
  total_score,
  total_par,
  score_to_par,
  total_putts,
  holes_played,
  status,
  reel_url,
  reel_duration_seconds,
  music_track_id,
  thumbnail_url,
  is_published,
  share_token,
  notes,
  created_at,
  updated_at
) ON public.rounds TO authenticated;


-- ----------------------------------------------------------------------------
-- FINDING (medium): sync-courses `sync_single` lets any signed-in user drive
-- unbounded service-role writes to the shared catalog.
--
-- Even with the INSERT-only + escaped-ILIKE hardening in the function, a user
-- can still call `sync_single` (and admins `sync_region`) in a loop to create
-- many junk courses / burn the external API quota. Add a tiny per-user, per-day
-- counter the function checks and increments. No RLS policies are defined, so
-- only the service role (which bypasses RLS) can read or write it — clients
-- cannot see or reset their own counter.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_course_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE public.sync_course_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service-role only.
