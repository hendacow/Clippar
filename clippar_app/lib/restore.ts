/**
 * Reinstall durability — metadata sync, orphan detection, Photos re-link.
 * Durability plan (org/cto/DATA_DURABILITY.md §6), ratified by Henry 1 Sep.
 *
 * Three cooperating pieces:
 *
 * 1. syncShotMetadata — every saved clip gets a lightweight `shots` row
 *    server-side (hole, shot, GPS — NO video bytes). Free users included:
 *    this is what lets a reinstall know WHICH clips existed and where they
 *    belonged. The upload queue already upserts onto these rows when Pro
 *    backup uploads the actual video, so no duplicates.
 *    THE PRO BOUNDARY, stated: metadata restores nothing without the
 *    phone's own Photos library in hand. Only Pro's video upload survives a
 *    LOST phone. Different losses, different products.
 *
 * 2. detectMissingMedia — finds clip rows whose file is gone. This is the
 *    honest answer to the mixed-restore trap: an iCloud device restore
 *    brings the database back but (deliberately — privacy promise) not the
 *    clip files. Rather than a library that looks restored and plays
 *    nothing, the app now KNOWS and says so.
 *
 * 3. restoreRoundFromPhotos — re-links a round's missing clips from the
 *    "Clippar" album: time-ordered album assets within the round's window,
 *    aligned to the round's time-ordered shot rows, copied back into app
 *    storage (the hybrid: the app owns its copy again after re-link).
 */
import { getClipsForRound, saveLocalClip, updateClipEditorState } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { createShot } from '@/lib/api';
import { persistAsset } from '@/lib/media';
import { videoExtension } from '@/lib/clipPaths';
import { CLIPPAR_ALBUM } from '@/lib/photosMirror';
import { Platform } from 'react-native';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const MediaLibrary = isNative
  ? (require('expo-media-library') as typeof import('expo-media-library'))
  : null;
const FileSystem = isNative
  ? (require('expo-file-system/legacy') as typeof import('expo-file-system/legacy'))
  : null;

/** Fire-and-forget after a clip saves. Never blocks or fails a save. */
export async function syncShotMetadata(clip: {
  roundId: string;
  holeNumber: number;
  shotNumber: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
}): Promise<void> {
  try {
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id;
    if (!userId) return;
    // The queue's own upsert pattern: update if the row exists, else insert.
    const { data: existing } = await supabase
      .from('shots')
      .select('id')
      .eq('round_id', clip.roundId)
      .eq('hole_number', clip.holeNumber)
      .eq('shot_number', clip.shotNumber)
      .maybeSingle();
    if (existing?.id) return; // row already there (e.g. Pro upload beat us)
    await createShot({
      round_id: clip.roundId,
      user_id: userId,
      hole_number: clip.holeNumber,
      shot_number: clip.shotNumber,
      gps_latitude: clip.gpsLatitude,
      gps_longitude: clip.gpsLongitude,
    });
  } catch {
    // Offline or transient — the Pro upload path upserts later anyway.
  }
}

export interface MissingMedia {
  roundId: string;
  missing: number;
  total: number;
}

/** Rows whose files are gone — the fingerprint of a device restore. */
export async function detectMissingMedia(roundIds: string[]): Promise<MissingMedia[]> {
  if (!FileSystem) return [];
  const out: MissingMedia[] = [];
  for (const roundId of roundIds) {
    try {
      const clips = await getClipsForRound(roundId);
      if (clips.length === 0) continue;
      let missing = 0;
      for (const c of clips) {
        if (!c.file_uri?.startsWith('file://')) continue;
        const info = await FileSystem.getInfoAsync(c.file_uri).catch(() => ({ exists: false }));
        if (!info.exists) missing += 1;
      }
      if (missing > 0) out.push({ roundId, missing, total: clips.length });
    } catch {}
  }
  return out;
}

export interface RestoreResult {
  relinked: number;
  missing: number;
}

/**
 * Re-link one round's missing clips from the Clippar album. Alignment:
 * the round's shot rows ordered by (hole, shot) against the album's assets
 * ordered by creationTime within the round's recording window — mirroring
 * writes one asset per shot in recording order, so order alignment is
 * exact for mirrored rounds. Assets are copied back into app storage: the
 * hybrid owns its copy again after re-link.
 */
export async function restoreRoundFromPhotos(roundId: string): Promise<RestoreResult> {
  if (!MediaLibrary || !FileSystem) return { relinked: 0, missing: 0 };
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (perm.status !== 'granted') return { relinked: 0, missing: 0 };

  const clips = await getClipsForRound(roundId);
  const gone: typeof clips = [];
  for (const c of clips) {
    const info = await FileSystem.getInfoAsync(c.file_uri).catch(() => ({ exists: false }));
    if (!info.exists) gone.push(c);
  }
  if (gone.length === 0) return { relinked: 0, missing: 0 };

  const album = await MediaLibrary.getAlbumAsync(CLIPPAR_ALBUM).catch(() => null);
  if (!album) return { relinked: 0, missing: gone.length };

  // The round's recording window, padded a day each side.
  const times = clips.map((c) => new Date(c.timestamp).getTime()).filter((t) => Number.isFinite(t));
  const windowStart = Math.min(...times) - 86_400_000;
  const windowEnd = Math.max(...times) + 86_400_000;

  const page = await MediaLibrary.getAssetsAsync({
    album,
    mediaType: 'video',
    first: 500,
    sortBy: [[MediaLibrary.SortBy.creationTime, true]],
  });
  const candidates = page.assets.filter(
    (a) => a.creationTime >= windowStart && a.creationTime <= windowEnd
  );

  // Direct hit first: rows that still carry their photos_asset_id.
  let relinked = 0;
  const usedAssetIds = new Set<string>();
  for (const c of gone) {
    let asset =
      (c.photos_asset_id && candidates.find((a) => a.id === c.photos_asset_id)) || null;
    if (!asset) {
      // Order alignment: nth missing row ↔ nth unused candidate by time.
      asset = candidates.find((a) => !usedAssetIds.has(a.id)) ?? null;
    }
    if (!asset) continue;
    usedAssetIds.add(asset.id);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: true });
      const src = info?.localUri ?? asset.uri;
      if (!src) continue;
      const filename = `relinked_${roundId}_h${c.hole_number}_s${c.shot_number}_${Date.now()}.${videoExtension(src)}`;
      const durable = await persistAsset(src, filename, { keepSource: true });
      await updateClipEditorState(c.id, { file_uri: durable });
      relinked += 1;
    } catch {}
  }
  return { relinked, missing: gone.length - relinked };
}
