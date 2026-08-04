-- ============================================================================
-- 019 — Tenant isolation: the remaining paths by which one ordinary signed-in
--        account can reach another account's data, or mint itself an
--        entitlement it never paid for.
--
-- THREAT MODEL. The attacker is a normal signed-up user. They hold the shipped
-- anon key (it is in every IPA and is publishable by design), a valid JWT for
-- their OWN account, and curl. They do not patch the app — they call PostgREST
-- and the Storage REST API directly, so nothing that lives in `lib/` is in the
-- path and no edge function, and therefore no `_shared/rateLimit.ts` counter,
-- structurally sees any of it. Every "the client checks this first" is not a
-- control against this person.
--
-- Everything below is an RLS / grant / trigger change. No user row is rewritten
-- and no column is dropped. The service role bypasses RLS and keeps its own
-- grants, so stripe-webhook, revenuecat-webhook, sync-courses, process-round,
-- create-share-link, get-shared-reel, delete-account and redeem-code are
-- unaffected.
--
-- ⚠ ROUND-RECORDING SAFETY. A round is recorded once, on a golf course, and
-- cannot be re-recorded; losing a golfer's footage to a policy change is worse
-- than the vulnerability. So: every tightening names the app code path it was
-- checked against, and nothing here narrows `rounds` by enumerating columns.
-- 015 already had to patch 013 for precisely that reason — a column added later
-- falls outside an explicit list and the client starts getting 403s mid-round.
-- Where an INSERT needed constraining (section 3) a trigger NORMALISES the
-- value rather than refusing the row, so a write during a round cannot fail on
-- it.
-- ============================================================================


-- ============================================================================
-- 1. `profiles` — a client can still author its own subscription row
-- ============================================================================
--
-- ATTACK. Migration 013 revoked the table-wide UPDATE grant and re-granted a
-- column list, because RLS cannot express column-level write rules and
-- `subscription_status` is what lib/subscription.ts:107-113 reads as proof of
-- Pro. It left the table-wide INSERT grant alone, and the INSERT policy
-- (001:27) is `WITH CHECK (auth.uid() = id)` — it constrains WHICH ROW, never
-- WHICH COLUMNS. So every column, including the two billing ones, is
-- client-settable at insert time:
--
--   POST /rest/v1/profiles
--     {"id":"<own uid>","email":"…",
--      "subscription_status":"active","subscription_expires_at":null}
--
-- `status='active'` with a NULL expiry is read as LIFETIME Pro by
-- lib/subscription.ts:110-111 and by public.has_active_pro() (017:81-87), which
-- is also what gates the Pro-only branch of the clips storage INSERT policy.
-- One request, no purchase, no webhook, permanent.
--
-- The only thing standing in the way today is that the row usually already
-- exists (the handle_new_user trigger), and a PostgREST upsert cannot get in
-- either because merge-duplicates needs the UPDATE privilege 013 revoked. But
-- "the row happens to exist" is not an authorisation control, and there are at
-- least two ways it does not:
--   • handle_new_user (001:44-46) swallows every exception and returns NEW, so
--     a failed signup insert is silent. lib/api.ts:44-58 exists specifically to
--     paper over that case, which is proof it happens.
--   • delete-account deletes the profile row (index.ts:211) BEFORE
--     auth.admin.deleteUser (index.ts:213). If that last call fails the handler
--     throws a 500 — and the caller still holds a working session for an
--     account whose profile row is now gone.
--
-- FIX. Mirror 013 exactly: revoke the blanket INSERT and re-grant INSERT on the
-- non-privileged columns only. Billing columns become service-role-only on
-- INSERT as well as UPDATE, which is what 013's header always claimed.
--
-- VERIFIED AGAINST: lib/api.ts getProfile() (api.ts:44-58) is the ONLY client
-- INSERT into profiles anywhere in the app — it sends exactly
-- {id, email, display_name} and every one of those is in the list below. The
-- other three client touch points are reads or already-permitted updates:
-- lib/api.ts updateProfile (UPDATE), lib/notifications.ts:48-51
-- (expo_push_token UPDATE), lib/subscription.ts:115-131 (the optimistic
-- 'expired' write 013 already denies and the client already discards).
-- handle_new_user is SECURITY DEFINER and runs as the function owner, so the
-- signup trigger is not affected by a grant made to `authenticated`.
-- ----------------------------------------------------------------------------
REVOKE INSERT ON public.profiles FROM anon, authenticated;

GRANT INSERT (
  id,
  display_name,
  email,
  handicap,
  home_course,
  avatar_url,
  ble_device_id,
  expo_push_token,
  created_at,
  updated_at
) ON public.profiles TO authenticated;


-- ============================================================================
-- 2. `shots` — ownership is checked on the wrong column
-- ============================================================================
--
-- ATTACK. "Users can manage own shots" (001:182-184) binds `auth.uid()` to
-- `shots.user_id` and says nothing about `shots.round_id`. A shot row therefore
-- only has to CLAIM to be yours; it can point at anybody's round:
--
--   POST /rest/v1/shots
--     {"user_id":"<own uid>","round_id":"<victim round>",
--      "hole_number":1,"shot_number":1,"clip_url":"…"}
--
-- WITH CHECK passes, and the row lands inside another user's round. Two
-- consequences, the first of which is the serious one:
--
--   a) DESTROYING A ROUND IN PROGRESS. 017:324-352 caps a round at 300 shots
--      and the cap counts EVERY row for that round_id, not just the caller's.
--      300 planted rows and the owner's next legitimate insert raises
--      check_violation — on a golf course, mid-round, for footage that cannot
--      be re-recorded. The cap was added to bound abuse and this turns it into
--      the weapon.
--   b) FEEDING THE PIPELINE. process-round dispatches Modal, which reads the
--      round back with the SERVICE ROLE and therefore does not see shots RLS at
--      all. Rows the owner cannot even see in their own editor (their client
--      reads are filtered to auth.uid() = user_id) are still visible to the
--      composer.
--
-- The victim's round id is not a secret in the way a UUID normally is: it is
-- the object key in every signed reel URL the sharing flow hands out
-- (`…/object/sign/clips/reels/<roundId>.mp4`, get-shared-reel/index.ts:157), so
-- anyone who has ever been sent a share link holds one.
--
-- `scores` got this right in the same migration (001:156-158 joins to rounds
-- and checks rounds.user_id); `shots` simply did not. This is the missing half.
--
-- FIX. Keep the user_id binding and add the round-ownership join to WITH CHECK.
-- USING is unchanged: an attacker could never UPDATE or DELETE a victim's shot
-- row anyway, because those rows carry the victim's user_id.
--
-- The `r.user_id = auth.uid()` test inside the subquery is deliberately
-- explicit and not left to rounds' own RLS. It is redundant today — a policy
-- expression re-enters the referenced table's policies, which is why 017 needed
-- public.has_active_pro() to read profiles (017:62-66) — but if a public-read
-- policy is ever added back to `rounds` (see the note in section 4, it is a
-- tempting thing to do) the redundancy is what keeps this correct.
--
-- VERIFIED AGAINST: both callers of createShot insert into a round the caller
-- just created and owns.
--   • lib/uploadQueue.ts:178-190 does a `rounds` lookup and throws
--     "not found in Supabase" BEFORE any shot write, precisely so the FK cannot
--     fail; that lookup is itself RLS-scoped, so "found" already means "owned".
--   • app/round/import.tsx:706-712 passes the roundId returned by createRound.
-- The `local_…` round-id fallback that used to produce orphan shot writes was
-- removed (hooks/useRound.ts:157) and uploadQueue.ts:166-172 still refuses
-- those ids explicitly. There is no path that writes a shot before its round
-- row exists, so this WITH CHECK cannot fire on a legitimate round.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own shots" ON public.shots;
CREATE POLICY "Users can manage own shots" ON public.shots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id = shots.round_id
        AND r.user_id = auth.uid()
    )
  );


-- ============================================================================
-- 3. `rounds.dispatch_claimed_at` — service-role-only on UPDATE, not on INSERT
-- ============================================================================
--
-- 013:96-115 added `dispatch_claimed_at` as a claim stamp the client cannot
-- write, because `status` is client-writable and the app legitimately rewrites
-- it, so a status-based claim guard could be re-armed in a loop against a
-- ~14-minute Modal GPU job. It excluded the column from the UPDATE grant. The
-- INSERT grant was never touched, so a client can still choose the column's
-- value on the way in — the invariant holds for the second write of a row and
-- not the first.
--
-- Nothing exploitable falls out of that today: process-round's claim
-- (index.ts:184-189) treats a stale stamp as re-claimable, so a forged value
-- only ever costs the forger their own dispatch, and the per-day counter
-- (index.ts:154-158) counts rows at or after midnight, which planting can only
-- increase. It is recorded here as a hole because the whole point of a
-- service-role-only column is that a client cannot pick its value, and the next
-- person to reason about the claim will assume the column means what 013 says
-- it means.
--
-- FIX SHAPE MATTERS. The obvious fix — revoke INSERT and re-grant a column list
-- like 013 did for UPDATE — is the wrong tool on this table. `rounds` gains
-- columns (015 added start_hole and had to hand-patch 013's grant to keep the
-- client working), and a column missing from an INSERT grant fails round
-- CREATION, which is the first step of recording. A BEFORE INSERT trigger that
-- nulls the value instead never refuses a row and never needs maintaining when
-- a column is added. Same pattern 017:380-402 uses to stamp courses.submitted_by.
--
-- `auth.uid() IS NULL` returns early exactly as every 017 trigger does — that
-- is what keeps the service role, the edge functions and the migrations out of
-- it, and it is why process-round can still set the column.
--
-- VERIFIED AGAINST: lib/api.ts createRound (api.ts:121-133) is the only client
-- INSERT into rounds in the app and sends
-- {user_id, course_name, course_id, holes_played, start_hole, status} — it has
-- never set dispatch_claimed_at, so this trigger is a no-op on every real
-- round. Nothing is refused, so there is no new way for round creation to fail.
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER (the default), unlike 017's triggers — this one only rewrites
-- a field of NEW and needs no privilege the caller lacks, and `auth.uid()` reads
-- a session GUC so it resolves the same either way. Same shape as the other
-- pure-normalisation triggers in this schema (009, 012). search_path is still
-- pinned per 010; `auth.uid()` is schema-qualified so it resolves regardless.
CREATE OR REPLACE FUNCTION public.strip_privileged_rounds_insert_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    -- Service role / edge functions / migrations: trusted writers.
    RETURN NEW;
  END IF;

  NEW.dispatch_claimed_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strip_privileged_rounds_insert_columns ON public.rounds;
CREATE TRIGGER strip_privileged_rounds_insert_columns
  BEFORE INSERT ON public.rounds
  FOR EACH ROW EXECUTE FUNCTION public.strip_privileged_rounds_insert_columns();


-- ============================================================================
-- 4. `clips` storage — a latent bucket-wide read, and a reel keyspace that
--    nothing but the service role can touch
-- ============================================================================
--
-- Two separate problems in the SELECT/UPDATE/DELETE policies from 011. 017
-- rewrote INSERT and left these three as they were.
--
-- 4a. THE LATENT READ. 011's SELECT policy grants any authenticated user read
-- on the clips of a round that is `share_token IS NOT NULL AND is_published`.
-- That branch is inert right now for a reason nobody wrote down: the
-- `FROM public.rounds` inside a policy expression re-enters rounds' OWN RLS,
-- and 013:64 dropped the only policy that ever exposed another user's round
-- row. So the subquery cannot see a stranger's round and the branch never
-- matches.
--
-- It is one line away from matching again. `is_published` is never set to true
-- by any code in this repo — grep the app: nothing writes it — which means
-- get-shared-reel's `round.is_published !== true` check (index.ts:126) refuses
-- every share link that create-share-link mints. When someone debugs that, the
-- shortest-looking fix is to restore the "Shared rounds are publicly viewable"
-- policy 013 removed. The moment they do, this branch wakes up and every RAW
-- PER-HOLE CLIP of every published round — the Pro cloud-backup footage, not
-- the reel — becomes readable and listable by any signed-in stranger:
--
--   supabase.storage.from('clips').list('')            → published round ids
--   supabase.storage.from('clips').list('<roundId>')   → their raw clips
--   supabase.storage.from('clips').createSignedUrl(…)  → playable video
--
-- It also serves nothing. Reels live at `reels/<roundId>.mp4`, whose
-- foldername[1] is the literal 'reels' and never a round uuid, so the branch
-- has never applied to the thing that actually gets shared; and the public
-- viewer at clippargolf.com is ANONYMOUS, reaching reels only through
-- get-shared-reel, which runs as the service role and bypasses storage RLS
-- entirely. Deleting the branch changes nothing today and removes the trapdoor.
--
-- 4b. THE OWNER CANNOT REACH THEIR OWN REEL. 017 added `reels/<roundId>.mp4` to
-- the INSERT policy but the other three still only understand the
-- `<roundId>/<file>` shape, so for the reel keyspace: the owner cannot SELECT
-- (lib/resolveReelSource.ts:112 signs `clips/reels/…` and gets nothing back —
-- the round-detail reel preview is dead for cloud-stored reels), cannot UPDATE
-- (lib/r2.ts:172 uploads with `x-upsert: true`, which is an UPDATE once the key
-- exists, so re-composing and re-uploading a reel 403s), and cannot DELETE.
-- This is a security problem and not just a bug, because the visible symptom is
-- "reels don't work" and the obvious cure is to widen the policy back to
-- `bucket_id = 'clips'`, which is what 011 was written to undo.
--
-- 4c. UPDATE's WITH CHECK was `bucket_id = 'clips'` — it constrains the bucket
-- and not the destination key. Storage's move/copy operations are an UPDATE of
-- storage.objects, so an owner of round A could rename an object INTO round B's
-- folder. Nothing in the app calls .move()/.copy() (grepped), and
-- lib/api.ts:1136-1147 getFirstClipSignedUrl renders whichever object sorts
-- first in `clips/<roundId>/` on the victim's home screen — i.e. a planted
-- object plays as the victim's round. Making WITH CHECK identical to USING
-- costs nothing: an upsert onto an existing key keeps the same name, so the
-- legitimate retry path (lib/r2.ts:150-183) still passes.
--
-- VERIFIED AGAINST: lib/api.ts getSignedClipUrls (api.ts:946-963) and
-- getFirstClipSignedUrl (1136-1147), lib/r2.ts getClipUrl (r2.ts:380-397) and
-- uploadReelToStorage (r2.ts:351-370), lib/resolveReelSource.ts:105-115,
-- lib/sharing.ts ensureReelUploaded (157-188), lib/api.ts deleteRound (150-173)
-- and lib/uploadQueue.ts uploadRoundClips. Every one of them addresses either
-- `<ownRoundId>/<file>` or `reels/<ownRoundId>.mp4`, and both are permitted
-- below. delete-account (index.ts:150-168) runs as the service role and never
-- consults these policies at all.
-- ----------------------------------------------------------------------------

-- READ: your own round's clips, and your own round's reel. No stranger branch.
DROP POLICY IF EXISTS "Authenticated users can read clips" ON storage.objects;
DROP POLICY IF EXISTS "Users read own or shared-round clips" ON storage.objects;
DROP POLICY IF EXISTS "Users read own-round clips and reels" ON storage.objects;
CREATE POLICY "Users read own-round clips and reels"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.user_id = auth.uid()
        AND (
          r.id::text = (storage.foldername(name))[1]
          OR name = 'reels/' || r.id::text || '.mp4'
        )
    )
  );

-- UPDATE: owner only, and the DESTINATION key must be owned too (4c).
DROP POLICY IF EXISTS "Authenticated users can update clips" ON storage.objects;
DROP POLICY IF EXISTS "Users update own-round clips" ON storage.objects;
DROP POLICY IF EXISTS "Users update own-round clips and reels" ON storage.objects;
CREATE POLICY "Users update own-round clips and reels"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.user_id = auth.uid()
        AND (
          r.id::text = (storage.foldername(name))[1]
          OR name = 'reels/' || r.id::text || '.mp4'
        )
    )
  )
  WITH CHECK (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.user_id = auth.uid()
        AND (
          r.id::text = (storage.foldername(name))[1]
          OR name = 'reels/' || r.id::text || '.mp4'
        )
    )
  );

-- DELETE: owner only.
DROP POLICY IF EXISTS "Authenticated users can delete clips" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own-round clips" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own-round clips and reels" ON storage.objects;
CREATE POLICY "Users delete own-round clips and reels"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.user_id = auth.uid()
        AND (
          r.id::text = (storage.foldername(name))[1]
          OR name = 'reels/' || r.id::text || '.mp4'
        )
    )
  );


-- ----------------------------------------------------------------------------
-- 4d. The `clips` bucket must be PRIVATE.
--
-- Migration 008 created it with `public = false`, but its ON CONFLICT clause
-- only refreshes file_size_limit and allowed_mime_types — so if the prod bucket
-- was created from the dashboard with the public toggle on, re-running 008
-- never turned it off, and every policy above is decoration: a public bucket
-- serves /object/public/clips/<key> to anyone with the URL and no credential at
-- all, and the keys are `<roundId>/…` and `reels/<roundId>.mp4`.
--
-- Safe to force. Every read path in the app mints a signed URL, which works on
-- a private bucket; get-shared-reel signs server-side; and
-- lib/resolveReelSource.ts:97-104 already rewrites a legacy
-- `/object/public/clips/…` value by re-signing the path out of it.
-- ----------------------------------------------------------------------------
UPDATE storage.buckets SET public = FALSE WHERE id = 'clips' AND public;


-- ============================================================================
-- 5. `public.seed_course` — a 12-argument seeding helper exposed as an RPC
-- ============================================================================
--
-- 003:50-124 defines it for the seed data in that same file and never revokes
-- EXECUTE, so it defaults to PUBLIC — and PostgREST publishes every function in
-- `public` as /rest/v1/rpc/<name>. Any caller can therefore drive a course
-- insert plus eighteen `holes` upserts, with no validation of any argument, in
-- one request.
--
-- It is SECURITY INVOKER (003:124 closes the body with a bare LANGUAGE clause
-- and no SECURITY DEFINER), which is the only reason this is not an
-- escalation: RLS still applies to the caller,
-- 013 removed the UPDATE policies on courses/holes so the update branches match
-- nothing, and 017's insert caps still meter it because `auth.uid()` is intact
-- inside an invoker function. What is left is a large unvalidated RPC surface
-- that exists for one migration's benefit and that nothing calls at runtime.
-- Revoke it rather than keep re-deciding whether it is safe.
--
-- VERIFIED AGAINST: `seed_course(` appears only in migrations 003 and 004,
-- which run as the migration role and are unaffected by a revoke from PUBLIC.
-- No client, edge function or script references it (grepped).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'seed_course'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    RAISE NOTICE 'Revoked EXECUTE on %', fn.sig;
  END LOOP;
END $$;


-- ============================================================================
-- 6. Diagnostic: storage state this repository cannot see
-- ============================================================================
--
-- `clips` is the only bucket any migration creates or polices. The app also
-- addresses three others — `avatars` (app/profile/edit.tsx:96-113, key
-- `<userId>/avatar.<ext>`, uploaded with upsert:true and read with
-- getPublicUrl), `music` (lib/music.ts:78-82) and `reels`
-- (lib/api.ts:1116, lib/resolveReelSource.ts:112) — whose buckets and policies,
-- if they exist at all, were made in the dashboard and are invisible to code
-- review. `avatars` is the one that matters: the key is fully predictable from
-- a user id, so a bucket-wide INSERT/UPDATE policy there means one user can
-- overwrite another user's avatar with arbitrary content.
--
-- Adding policies here would not help — multiple permissive policies are OR'd,
-- so a new one can only ever widen access, never narrow it. Tightening requires
-- knowing the names of what is already there. So this prints them at deploy
-- time instead of guessing; act on the output, do not ignore it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  b record;
  p record;
BEGIN
  FOR b IN SELECT id, public, file_size_limit FROM storage.buckets ORDER BY id LOOP
    RAISE NOTICE '[019] bucket % public=% size_limit=%', b.id, b.public, b.file_size_limit;
  END LOOP;

  FOR p IN
    SELECT pol.polname AS name,
           pg_get_expr(pol.polqual, pol.polrelid)      AS using_expr,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
    FROM pg_policy pol
    WHERE pol.polrelid = 'storage.objects'::regclass
    ORDER BY pol.polname
  LOOP
    RAISE NOTICE '[019] storage.objects policy "%" USING % WITH CHECK %',
      p.name, COALESCE(p.using_expr, '-'), COALESCE(p.check_expr, '-');
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE '[019] storage catalog unreadable from this connection — run the enumeration query from TENANT_ISOLATION_2026-07-31.md in the SQL editor';
END $$;


-- PostgREST caches the schema and the grants; without this the changed profiles
-- INSERT privilege is not reflected until it restarts.
NOTIFY pgrst, 'reload schema';
