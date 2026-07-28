-- ============================================================================
-- 017 — Authorisation hardening: storage ownership + entitlement, forgeable
--        order rows, and unbounded client-driven row/object growth.
--
-- Everything here is an RLS / grant / trigger change. No data is rewritten.
-- The service role bypasses RLS and keeps its own grants, so stripe-webhook,
-- revenuecat-webhook, sync-courses, process-round and delete-account are
-- unaffected — every trigger below returns early when `auth.uid()` is NULL,
-- which is the case for a service-role connection and for migrations.
--
-- ⚠ DEPLOY ORDER (section 1 only): the clips INSERT policy starts requiring a
-- server-side Pro entitlement, and `profiles.subscription_status` is written by
-- exactly one thing — the revenuecat-webhook (its applyState, index.ts:135-148;
-- client writes to those columns were revoked in 013). Confirm the RevenueCat
-- dashboard webhook is configured and delivering BEFORE applying this to prod,
-- or real subscribers get 403 on cloud backup. Verify on DEV first with a Pro
-- account and a free account.
-- ============================================================================


-- ============================================================================
-- 1. `clips` storage bucket — owner scope, entitlement, and a byte/object cap
-- ============================================================================
--
-- Migration 011 owner-scoped SELECT/UPDATE/DELETE but deliberately left INSERT
-- as `WITH CHECK (bucket_id = 'clips')` — bucket-wide for every authenticated
-- role. Its header parked that on "a clip can upload before its round row has
-- synced". That is no longer true and arguably never was: uploadRoundClips
-- (lib/uploadQueue.ts:170-189) does a `rounds` lookup and throws
-- "Round … not found in Supabase" before the first byte is uploaded, precisely
-- so the later `shots.round_id` FK cannot fail. The round row always exists
-- first, so a round-ownership WITH CHECK is safe.
--
-- What the bucket-wide policy allowed, all with nothing but the shipped anon
-- key and an ordinary signed-in session — no client patching, no edge function
-- in the path, so `_shared/rateLimit.ts` structurally could not see any of it:
--
--   a) Writing into ANOTHER user's round folder: POST
--      /storage/v1/object/clips/<victimRoundId>/anything.mp4. Planted objects
--      become readable to every authenticated user the moment that round is
--      published, because the 011 READ policy grants published rounds broadly.
--   b) Squatting a victim's reel key `reels/<victimRoundId>.mp4`. Reels under
--      5 MB upload with a plain POST (lib/r2.ts:165-176), which 409s on an
--      existing key, and UPDATE is owner-scoped — so the victim can neither
--      write nor overwrite, and their share flow is permanently broken.
--   c) Unbounded volume. 500 MB per object (008:16), no object-count or byte
--      cap anywhere, and no `rounds` row required — the folder segment was an
--      arbitrary attacker-chosen UUID, so the blobs were also invisible to
--      delete-account's cleanup (which enumerates only the user's real round
--      ids, delete-account/index.ts:150-168) and survived account deletion.
--   d) Free accounts using the one feature Pro sells. The cloud-backup gate
--      lived only in the client (app/profile/storage-settings.tsx:38-49 and
--      lib/uploadQueue.ts:92-105); the server held no entitlement opinion at
--      all about the resource the entitlement is supposed to buy.
--
-- The rewritten policy below closes (a)-(d) in one WITH CHECK.

-- ----------------------------------------------------------------------------
-- Entitlement predicate. Deliberately a function and not inline SQL so the
-- storage policy, and anything added later, share one definition of "Pro".
--
-- SECURITY DEFINER because a storage.objects policy is evaluated as the
-- `authenticated` role: reading public.profiles from there would re-enter that
-- table's own RLS, and the answer must not depend on which policies happen to
-- exist on profiles. `auth.uid()` reads a session GUC, so it still resolves to
-- the *calling* user inside a definer function.
--
-- search_path is pinned per migration 010 — an unpinned SECURITY DEFINER
-- function can be hijacked by a caller who creates a shadowing object in a
-- schema earlier on the path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_pro()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Mirrors lib/subscription.ts:107-133: 'trial' and 'active' both grant
  -- access, and a NULL expiry means lifetime/perpetual rather than "expired".
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.subscription_status IN ('active', 'trial')
      AND (p.subscription_expires_at IS NULL OR p.subscription_expires_at > now())
  );
$$;

REVOKE ALL ON FUNCTION public.has_active_pro() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_active_pro() TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- Per-user storage cap.
--
-- The cap has to exist even with ownership + entitlement in place, because
-- neither bounds VOLUME: a subscriber (or anyone who takes over a subscriber's
-- session) can still write 500 MB objects in a loop, and Storage egress is
-- billed per GB. This is the only place that limit can live — uploads go
-- straight to the Storage REST API and never touch an edge function.
--
-- Counted over the user's own keyspace: `<roundId>/…` clips plus the one
-- `reels/<roundId>.mp4` per round. `split_part` rather than
-- storage.foldername so the partial index below is usable; over-counting a
-- stray root-level object would only make the cap stricter, never looser.
--
-- Limits are sized off real usage, not off round numbers: ~72 trimmed clips
-- per 18 holes at ~15 MB each is ≈1 GB per round, so 25 GB is roughly 25
-- backed-up rounds — comfortably above a weekly golfer for a season, and far
-- below a number worth attacking a Storage bill with. Raise them here if real
-- users start hitting the ceiling; do not remove the check.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clips_quota_ok()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_bytes   CONSTANT BIGINT := 26843545600;  -- 25 GB
  max_objects CONSTANT BIGINT := 10000;
  v_uid       UUID := auth.uid();
  v_count     BIGINT;
  v_bytes     BIGINT;
BEGIN
  IF v_uid IS NULL THEN
    -- Service role / migrations: not a client upload, nothing to meter.
    RETURN TRUE;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(COALESCE((o.metadata->>'size')::BIGINT, 0)), 0)
    INTO v_count, v_bytes
  FROM storage.objects o
  WHERE o.bucket_id = 'clips'
    AND (
      split_part(o.name, '/', 1) IN (
        SELECT r.id::text FROM public.rounds r WHERE r.user_id = v_uid
      )
      OR o.name IN (
        SELECT 'reels/' || r.id::text || '.mp4' FROM public.rounds r WHERE r.user_id = v_uid
      )
    );

  RETURN v_count < max_objects AND v_bytes < max_bytes;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_quota_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clips_quota_ok() TO authenticated, service_role;

-- Without this index the quota query is a sequential scan of storage.objects on
-- every single upload — which turns the cap itself into the DoS. storage is
-- owned by supabase_storage_admin, so the CREATE may be refused depending on
-- how the migration is applied; swallow that rather than failing the whole
-- migration, and create it by hand from the SQL editor if the NOTICE fires.
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS objects_clips_round_folder_idx
    ON storage.objects (split_part(name, '/', 1))
    WHERE bucket_id = 'clips';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'objects_clips_round_folder_idx not created (needs storage owner) — create it manually';
END;
$$;


-- ----------------------------------------------------------------------------
-- The policy itself.
--
-- Two disjoint branches, because the two keyspaces have genuinely different
-- authorisation rules:
--
--   * `reels/<roundId>.mp4` — NOT entitlement-gated. Sharing a reel is a free
--     feature (lib/sharing.ts:157-188 ensureReelUploaded is called from
--     getShareUrl for every user, explicitly "regardless of the cloud-backup
--     toggle"). Gating this on Pro would break sharing for free accounts.
--   * `<roundId>/<filename>` — raw-clip cloud backup, which IS what Pro sells.
--
-- The branches cannot overlap: storage.foldername('reels/x.mp4')[1] is 'reels',
-- never a round uuid.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can upload clips" ON storage.objects;
DROP POLICY IF EXISTS "Users upload clips to own rounds" ON storage.objects;
CREATE POLICY "Users upload clips to own rounds"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'clips'
    AND public.clips_quota_ok()
    AND (
      -- Reel for a round you own — free tier included.
      EXISTS (
        SELECT 1 FROM public.rounds r
        WHERE r.user_id = auth.uid()
          AND name = 'reels/' || r.id::text || '.mp4'
      )
      -- Raw clip backup into a round you own — Pro only.
      OR (
        public.has_active_pro()
        AND EXISTS (
          SELECT 1 FROM public.rounds r
          WHERE r.user_id = auth.uid()
            AND r.id::text = (storage.foldername(name))[1]
        )
      )
    )
  );

-- Per-object ceiling. 500 MB was inherited from prod and is ~10x anything the
-- app can legitimately produce: reels are hard-capped at 50 MB client-side
-- after two compression passes (lib/r2.ts:340-347) and a trimmed swing clip is
-- tens of MB. A high ceiling only ever helps whoever is trying to fill the
-- bucket in as few requests as possible.
UPDATE storage.buckets
   SET file_size_limit = 209715200  -- 200 MB
 WHERE id = 'clips'
   AND (file_size_limit IS NULL OR file_size_limit > 209715200);


-- ============================================================================
-- 2. `hardware_orders` — remove the client's ability to author payment records
-- ============================================================================
--
-- "Users can create own orders" (001:237) checks only `auth.uid() = user_id`,
-- and unlike profiles/rounds in 013 the table-wide INSERT grant to
-- `authenticated` was never revoked. Every column was therefore client-settable
-- at insert time, including the two Spec 5.2 names outright: `status` (a
-- fulfilment state whose CHECK list contains 'paid' and 'shipped') and
-- `amount_cents` (a price, with no lower bound). `stripe_payment_intent_id` is
-- nullable, so nothing tied a row to an actual payment:
--
--   POST /rest/v1/hardware_orders
--     {"user_id":"<self>","amount_cents":0,"status":"paid","kit_type":"premium", …}
--
-- …and app/profile/orders.tsx renders it as a genuine paid Premium Kit order.
--
-- No client code has ever inserted here — the only writer is the service-role
-- stripe-webhook (stripe-webhook/index.ts:40) — so this policy granted a
-- capability nothing needs. Drop it, and drop the grants too: the policy alone
-- was not the whole permission, and a future policy added without thinking
-- about grants should not silently re-open the door.
--
-- SELECT-own (001:236) is untouched, which is all the client reads.
-- delete-account deletes these rows as the service role (index.ts:184), which
-- bypasses both RLS and these grants.
DROP POLICY IF EXISTS "Users can create own orders" ON public.hardware_orders;
REVOKE INSERT, UPDATE, DELETE ON public.hardware_orders FROM anon, authenticated;


-- ============================================================================
-- 3. Volume caps on client-writable tables
-- ============================================================================
--
-- Shared prelude for the caps below. All of them reuse
-- `public.consume_rate_limit` from 016 rather than growing a counter table per
-- limit; it is atomic (INSERT … ON CONFLICT … RETURNING takes a row lock), so
-- firing N requests concurrently cannot walk past the cap the way a
-- read-then-write counter can.
--
-- Every trigger returns early when `auth.uid()` IS NULL. That is what keeps the
-- service role, the edge functions and the seed migrations out of the meter —
-- they are trusted writers and must not consume a user's budget.


-- ----------------------------------------------------------------------------
-- 3a. `rounds` — bulk insert via PostgREST
--
-- "Users can manage own rounds" (001:130) is FOR ALL with no volume constraint,
-- and 013 only column-scoped UPDATE. The app inserts one row at a time
-- (lib/api.ts:121-132) but PostgREST accepts a JSON ARRAY on the same endpoint,
-- so one request can create thousands of rows, and nothing on that path
-- traverses an edge function. Rounds are also the setup step for other abuse:
-- a `rounds` row is now what makes a clips folder writable (section 1), so an
-- unbounded rounds table would hand back the storage keyspace this migration
-- just took away.
--
-- A BEFORE INSERT trigger fires per row, so a 10,000-row array aborts on row 51
-- and the whole statement rolls back. PostgREST surfaces the RAISE as a 4xx.
-- 50/day is ~25x a golfer's real usage (one round, occasionally two).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_rounds_insert_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_allowed BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT allowed INTO v_allowed
  FROM public.consume_rate_limit('rounds-insert', v_uid::text, 50, 86400);

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'round creation limit reached (50 per day)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_rounds_insert_cap ON public.rounds;
CREATE TRIGGER enforce_rounds_insert_cap
  BEFORE INSERT ON public.rounds
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rounds_insert_cap();


-- ----------------------------------------------------------------------------
-- 3b. `shots` — per-round cap
--
-- Same unbounded-array problem on the child table, and `shots` is the row that
-- points at a storage object. Bounded per round rather than per day because
-- that is the real invariant: 18 holes at even a catastrophic 16 strokes is
-- under 300, so this can only ever fire on abuse. `idx_shots_round` makes the
-- count an index scan.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_shots_per_round_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_shots CONSTANT INTEGER := 300;
  v_count   INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.shots s WHERE s.round_id = NEW.round_id;

  IF v_count >= max_shots THEN
    RAISE EXCEPTION 'shot limit reached for this round (% max)', max_shots
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_shots_per_round_cap ON public.shots;
CREATE TRIGGER enforce_shots_per_round_cap
  BEFORE INSERT ON public.shots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_shots_per_round_cap();


-- ----------------------------------------------------------------------------
-- 3c. `courses` / `holes` — the shared catalog
--
-- 013 dropped the UPDATE policies on both tables but left
-- `FOR INSERT TO authenticated WITH CHECK (TRUE)` (007:17-18, 007:26-27) — no
-- owner column, no cap, no validation. POST /rest/v1/courses and
-- /rest/v1/holes reach those directly, which bypasses the 20/day
-- `sync_course_usage` cap in sync-courses entirely (that cap only meters the
-- edge function). Two live abuses: tens of thousands of junk `courses` rows
-- polluting the search every user hits (lib/api.ts:382 searchCourses), and —
-- because UNIQUE(course_id, hole_number) only protects courses that ALREADY
-- have hole rows — seeding attacker-chosen pars onto any course whose
-- API payload carried no tee data, which getCourseHoles then serves to every
-- user's scorecard as authoritative par.
--
-- The INSERT policies are NOT dropped, contrary to the obvious fix, because
-- the legitimate flow still needs them: upsertCourseFromLiveApi (lib/api.ts:
-- 1216-1256) inserts the course row and its holes with the client's own
-- session when a user picks a course that is not yet cached, and
-- CourseSearch.tsx:157-181 depends on the returned uuid for the round's
-- course_id FK. Dropping the policy would fail course selection for every
-- course not in the seed list. Routing that through sync-courses is the right
-- end state and needs a client change; until then, bound and attribute it.
--
-- `submitted_by` is stamped by the trigger rather than by a column DEFAULT so
-- a client cannot null it out by sending the column explicitly.
-- ----------------------------------------------------------------------------
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.courses.submitted_by IS
  'Set by trigger to auth.uid() for client-inserted rows; NULL for service-role/seed rows. Attribution for the shared catalog — see migration 017.';

CREATE OR REPLACE FUNCTION public.enforce_courses_insert_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_allowed BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.submitted_by := v_uid;

  -- 20/day matches the existing sync_course_usage cap on the edge-function
  -- path, so the direct-PostgREST path can no longer be the cheaper way in.
  SELECT allowed INTO v_allowed
  FROM public.consume_rate_limit('courses-insert', v_uid::text, 20, 86400);

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'course creation limit reached (20 per day)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_courses_insert_cap ON public.courses;
CREATE TRIGGER enforce_courses_insert_cap
  BEFORE INSERT ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_courses_insert_cap();

-- Holes are inserted 18 at a time alongside a course, so the budget is the
-- course budget times a full 18-hole card, with headroom for the upsert
-- retries that fire the trigger without writing anything (a conflicting hole
-- row still evaluates BEFORE INSERT before ON CONFLICT discards it).
CREATE OR REPLACE FUNCTION public.enforce_holes_insert_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_allowed BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT allowed INTO v_allowed
  FROM public.consume_rate_limit('holes-insert', v_uid::text, 500, 86400);

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'hole creation limit reached (500 per day)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_holes_insert_cap ON public.holes;
CREATE TRIGGER enforce_holes_insert_cap
  BEFORE INSERT ON public.holes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_holes_insert_cap();


-- PostgREST caches the schema; without this the new column and the changed
-- grants are not reflected until it restarts.
NOTIFY pgrst, 'reload schema';
