-- Add photos_asset_id to shots so clip files can be re-hydrated from the
-- user's Photos library after a reinstall (when the app's documentDirectory
-- has been wiped and the user opted out of cloud backup but had raw-clip
-- mirroring on, OR the clip was originally imported from Photos and the
-- localIdentifier still points at a live asset).
ALTER TABLE shots ADD COLUMN IF NOT EXISTS photos_asset_id text;
COMMENT ON COLUMN shots.photos_asset_id IS
  'iOS PhotoKit localIdentifier (or Android MediaStore uri) for the source video. Used by photosRecovery on reinstall to re-import the clip from the user''s Photos library.';
