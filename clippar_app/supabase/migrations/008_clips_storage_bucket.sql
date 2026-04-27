-- The dev Supabase project was created via the dashboard but never had a
-- `clips` storage bucket. Cloud-backup uploads from the app then return
-- {"statusCode":"404","error":"Bucket not found"}. Create the bucket and
-- the auth policies needed for authenticated users to upload / read their
-- own clips.
--
-- Idempotent: ON CONFLICT DO NOTHING for the bucket row, DROP IF EXISTS
-- on the policies so re-running on prod (which already has them via the
-- dashboard) doesn't error.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'clips',
  'clips',
  false,
  524288000,                                       -- 500 MB cap (matches prod)
  ARRAY['video/mp4', 'video/quicktime', 'video/mov']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Authenticated users can upload to the bucket (path scope is enforced at
-- application level — clips/<roundId>/<filename>).
DROP POLICY IF EXISTS "Authenticated users can upload clips" ON storage.objects;
CREATE POLICY "Authenticated users can upload clips"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'clips');

-- Users can read their own clips (signed URLs are minted server-side
-- regardless, this lets the supabase-js client read them too if needed).
DROP POLICY IF EXISTS "Authenticated users can read clips" ON storage.objects;
CREATE POLICY "Authenticated users can read clips"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'clips');

-- Allow updates so the upload queue can retry / overwrite on x-upsert.
DROP POLICY IF EXISTS "Authenticated users can update clips" ON storage.objects;
CREATE POLICY "Authenticated users can update clips"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'clips')
  WITH CHECK (bucket_id = 'clips');

-- And delete so the user can clear their own data.
DROP POLICY IF EXISTS "Authenticated users can delete clips" ON storage.objects;
CREATE POLICY "Authenticated users can delete clips"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'clips');
