-- ============================================================================
-- 016 — RLS scaling: hoist auth.uid() into an InitPlan + index the columns
--       every RLS policy filters on.
--
-- Two pure-performance changes. NO policy semantics change: every USING /
-- WITH CHECK expression below is byte-for-byte the one it replaces except that
-- `auth.uid()` becomes `(select auth.uid())`. Role targeting (`TO ...` or its
-- absence, i.e. PUBLIC), command (`FOR ...`), and the presence/absence of a
-- WITH CHECK clause are all preserved exactly.
--
-- PROBLEM 1 — per-row re-evaluation of auth.uid().
--   `auth.uid()` is STABLE, but referenced bare in a policy predicate the
--   planner treats it as part of the per-row qual and calls it once per
--   candidate row (it parses the request JWT out of a GUC every time). Worse,
--   the qual is then not a plain `user_id = <const>`, so it is not pushed down
--   as an index condition — every policy-filtered scan degrades to a seq scan
--   plus N function calls. Wrapping it as `(select auth.uid())` makes it an
--   uncorrelated subquery, which Postgres evaluates ONCE as an InitPlan and
--   folds into the scan as a constant — restoring index usage.
--
-- PROBLEM 2 — RLS-filtered columns with no supporting btree index.
--   A policy qual can only use an index if one exists. See the audit note in
--   the index section below for exactly which columns were and were not
--   already covered.
--
-- TRANSACTION NOTE: this file is deliberately transactional (no CREATE INDEX
-- CONCURRENTLY). Two reasons:
--   1. `supabase db push` / `supabase migration up` applies each migration file
--      inside a transaction, and CREATE INDEX CONCURRENTLY errors out with
--      "cannot run inside a transaction block" there.
--   2. Dropping and recreating a policy must be atomic. If the transaction
--      split, there would be a window where a table had NO policy for a
--      command — which, with RLS enabled, denies access rather than allowing
--      it, but still means live requests fail mid-deploy.
--   All indexed tables are small today (see the header of each CREATE INDEX),
--   so the brief ACCESS EXCLUSIVE lock is a non-event. If any of these tables
--   has grown large by the time this is applied to prod, create the indexes
--   out-of-band first with the CONCURRENTLY forms listed at the bottom of this
--   file; the IF NOT EXISTS guards then make this migration's index section a
--   no-op.
-- ============================================================================


-- ============================================================================
-- PART 1 — Policies: auth.uid() → (select auth.uid())
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles (001)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING ((select auth.uid()) = id);

-- NOTE: no WITH CHECK, matching 001. Column-level write scoping for this
-- policy lives in 013 (REVOKE UPDATE + column GRANT), not in the policy.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK ((select auth.uid()) = id);


-- ----------------------------------------------------------------------------
-- rounds (001) — "Shared rounds are publicly viewable" was dropped by 013 and
-- is intentionally NOT recreated here.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own rounds" ON public.rounds;
CREATE POLICY "Users can manage own rounds" ON public.rounds
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- scores (001) — ownership via the parent round.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own scores" ON public.scores;
CREATE POLICY "Users can manage own scores" ON public.scores
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.rounds
    WHERE rounds.id = scores.round_id AND rounds.user_id = (select auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.rounds
    WHERE rounds.id = scores.round_id AND rounds.user_id = (select auth.uid())
  ));


-- ----------------------------------------------------------------------------
-- shots (001)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own shots" ON public.shots;
CREATE POLICY "Users can manage own shots" ON public.shots
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- processing_jobs (001)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own jobs" ON public.processing_jobs;
CREATE POLICY "Users can view own jobs" ON public.processing_jobs
  FOR SELECT USING ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- hardware_orders (001)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own orders" ON public.hardware_orders;
CREATE POLICY "Users can view own orders" ON public.hardware_orders
  FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create own orders" ON public.hardware_orders;
CREATE POLICY "Users can create own orders" ON public.hardware_orders
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- daily_usage (001)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own usage" ON public.daily_usage;
CREATE POLICY "Users can view own usage" ON public.daily_usage
  FOR SELECT USING ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- admin_users (001) — self-referential EXISTS subquery.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Only super_admins can manage admins" ON public.admin_users;
CREATE POLICY "Only super_admins can manage admins" ON public.admin_users
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE user_id = (select auth.uid()) AND role = 'super_admin'
    )
  );


-- ----------------------------------------------------------------------------
-- course_suggestions (003)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create suggestions" ON public.course_suggestions;
CREATE POLICY "Users can create suggestions" ON public.course_suggestions
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own suggestions" ON public.course_suggestions;
CREATE POLICY "Users can view own suggestions" ON public.course_suggestions
  FOR SELECT USING ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- course_presets (009)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own presets" ON public.course_presets;
CREATE POLICY "Users can view own presets"
  ON public.course_presets FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own presets" ON public.course_presets;
CREATE POLICY "Users can insert own presets"
  ON public.course_presets FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own presets" ON public.course_presets;
CREATE POLICY "Users can update own presets"
  ON public.course_presets FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own presets" ON public.course_presets;
CREATE POLICY "Users can delete own presets"
  ON public.course_presets FOR DELETE
  USING ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- storage.objects — the `clips` bucket policies from 011.
--
-- These matter most of all: the qual runs per storage object in the bucket, so
-- a bare auth.uid() is one GUC parse + one correlated rounds probe PER CLIP.
-- The INSERT policy ("Authenticated users can upload clips") has no auth.uid()
-- and is left untouched.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users read own or shared-round clips" ON storage.objects;
CREATE POLICY "Users read own or shared-round clips"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND (
          r.user_id = (select auth.uid())
          OR (r.share_token IS NOT NULL AND r.is_published = TRUE)
        )
    )
  );

DROP POLICY IF EXISTS "Users update own-round clips" ON storage.objects;
CREATE POLICY "Users update own-round clips"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND r.user_id = (select auth.uid())
    )
  )
  WITH CHECK (bucket_id = 'clips');

DROP POLICY IF EXISTS "Users delete own-round clips" ON storage.objects;
CREATE POLICY "Users delete own-round clips"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND r.user_id = (select auth.uid())
    )
  );


-- ============================================================================
-- PART 2 — Indexes on RLS-filtered columns
--
-- AUDIT of every table with a user-scoped policy. A UNIQUE constraint creates a
-- btree index, and a btree index on (a, b) already serves a lookup on `a`
-- alone (leading-column prefix), so several columns that LOOK unindexed are in
-- fact already covered:
--
--   ALREADY COVERED — no index added, would be pure write overhead:
--     daily_usage(user_id)      UNIQUE(user_id, date)            → 001:268
--     scores(round_id)          UNIQUE(round_id, hole_number)    → 001:152
--     course_presets(user_id)   idx_course_presets_user_recent   → 009:56
--                               + UNIQUE(user_id, name)
--     rounds(user_id)           idx_rounds_user                  → 001:133
--     profiles(id)              PRIMARY KEY
--     sync_course_usage         PRIMARY KEY (user_id, usage_date) → 013:161
--     apple_credentials         PRIMARY KEY (user_id)             → 012:22
--
--   GENUINELY MISSING — created below.
-- ============================================================================

-- processing_jobs: "Users can view own jobs" filters user_id; the only index
-- on the table is the `id` PK. Grows one row per processing dispatch.
CREATE INDEX IF NOT EXISTS idx_processing_jobs_user
  ON public.processing_jobs (user_id);

-- processing_jobs.round_id is also an unindexed FK — every `DELETE FROM rounds`
-- (account deletion, round delete) seq-scans this table to enforce the CASCADE,
-- and the app looks jobs up by round. Same scan, same fix.
CREATE INDEX IF NOT EXISTS idx_processing_jobs_round
  ON public.processing_jobs (round_id);

-- hardware_orders: both policies ("view own orders", "create own orders")
-- filter user_id; only the `id` PK and the stripe_payment_intent_id UNIQUE
-- exist today.
CREATE INDEX IF NOT EXISTS idx_hardware_orders_user
  ON public.hardware_orders (user_id);

-- shots: "Users can manage own shots" filters user_id, but the sole index is
-- idx_shots_round (round_id, hole_number, shot_number) — round_id leads, so it
-- does NOT serve a user_id qual. This is the highest-row-count user-scoped
-- table in the schema (one row per shot per round), so it is the single most
-- valuable index here.
CREATE INDEX IF NOT EXISTS idx_shots_user
  ON public.shots (user_id);

-- course_suggestions: both policies filter user_id; the table has no index at
-- all beyond its `id` PK.
CREATE INDEX IF NOT EXISTS idx_course_suggestions_user
  ON public.course_suggestions (user_id);

-- admin_users: the super_admin EXISTS subquery filters user_id. The table is
-- tiny, but the subquery is re-planned into every admin_users access and the
-- index costs nothing to maintain at this size.
CREATE INDEX IF NOT EXISTS idx_admin_users_user
  ON public.admin_users (user_id);

-- rounds(id::text) — EXPRESSION index for the three storage.objects clips
-- policies. They join with `r.id::text = (storage.foldername(name))[1]`; the
-- cast on the indexed column makes the rounds PRIMARY KEY unusable, so each
-- clip row triggers a full seq scan of `rounds`. Indexing the cast expression
-- restores an index lookup without touching the policy predicate (rewriting it
-- to cast the folder name to uuid instead would throw on any non-uuid folder,
-- changing behaviour — so we index around it).
CREATE INDEX IF NOT EXISTS idx_rounds_id_text
  ON public.rounds ((id::text));


-- ============================================================================
-- APPENDIX — CONCURRENTLY forms.
--
-- Run these by hand (psql, autocommit, OUTSIDE any transaction) BEFORE applying
-- this migration if any of these tables has grown large enough that an ACCESS
-- EXCLUSIVE lock during index build is unacceptable. The IF NOT EXISTS guards
-- above then make Part 2 a no-op. Check afterwards for an INVALID index
-- (`\d+`, or `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`)
-- and re-run any that failed.
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_processing_jobs_user  ON public.processing_jobs (user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_processing_jobs_round ON public.processing_jobs (round_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hardware_orders_user  ON public.hardware_orders (user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shots_user            ON public.shots (user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_course_suggestions_user ON public.course_suggestions (user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_users_user      ON public.admin_users (user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rounds_id_text        ON public.rounds ((id::text));
-- ============================================================================
