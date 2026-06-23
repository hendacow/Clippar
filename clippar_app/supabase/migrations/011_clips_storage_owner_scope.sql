-- Owner-scope the `clips` storage bucket (SECURITY FIX).
--
-- Migration 008 created the clips policies as bucket-wide for ALL authenticated
-- users (`bucket_id = 'clips'`, no owner check). That let any signed-in user
-- list, read, overwrite, or DELETE any other user's clips — the UUID path was
-- the only "protection", and the SELECT policy itself exposed every path via
-- listing. This scopes read/update/delete to the owner of the ROUND the clip
-- belongs to. Clips live at `<roundId>/<filename>`, and `public.rounds` is
-- already correctly RLS-scoped to `auth.uid()`, so we join against it rather
-- than relying on the storage `owner` column (which may be unset on objects
-- uploaded via the REST API).
--
-- READ also honours the existing round-level share rule (published + share_token)
-- so public reel sharing keeps working. UPDATE/DELETE are owner-only.
--
-- INSERT is intentionally left bucket-wide for now: a clip can upload before its
-- round row has synced to Supabase, so a round-ownership WITH CHECK would break
-- the upload queue. The data-exfiltration / destruction vectors are
-- READ/UPDATE/DELETE, which this closes. Tighten INSERT once upload ordering is
-- confirmed. The app reads via client-side createSignedUrl and deletes via
-- client-side .remove(), both of which respect these policies; account deletion
-- runs server-side (service role) and bypasses RLS, so it is unaffected.
--
-- Idempotent (DROP IF EXISTS → CREATE). Apply to DEV first, verify (a) your own
-- clips still play and (b) a shared round still opens for another account, then
-- apply to PROD. Reversible by re-running migration 008's policies.

-- READ: clips of a round you own, or a published/shared round.
DROP POLICY IF EXISTS "Authenticated users can read clips" ON storage.objects;
CREATE POLICY "Users read own or shared-round clips"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND (
          r.user_id = auth.uid()
          OR (r.share_token IS NOT NULL AND r.is_published = TRUE)
        )
    )
  );

-- UPDATE: owner only (blocks overwriting another user's clip).
DROP POLICY IF EXISTS "Authenticated users can update clips" ON storage.objects;
CREATE POLICY "Users update own-round clips"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND r.user_id = auth.uid()
    )
  )
  WITH CHECK (bucket_id = 'clips');

-- DELETE: owner only (blocks wiping another user's clips).
DROP POLICY IF EXISTS "Authenticated users can delete clips" ON storage.objects;
CREATE POLICY "Users delete own-round clips"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'clips'
    AND EXISTS (
      SELECT 1 FROM public.rounds r
      WHERE r.id::text = (storage.foldername(name))[1]
        AND r.user_id = auth.uid()
    )
  );

-- INSERT: unchanged (see header note). Re-asserted so the policy set is
-- complete and self-documenting after the DROPs above.
DROP POLICY IF EXISTS "Authenticated users can upload clips" ON storage.objects;
CREATE POLICY "Authenticated users can upload clips"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'clips');
