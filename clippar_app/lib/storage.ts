import * as SQLite from 'expo-sqlite';
import {
  ownedRoundsClause,
  isRowVisible,
  shouldClaimLegacyRows,
} from './localScope';
import { evictableUriSql, isPurgeableAppPath, videoExtension } from './clipPaths';
import { persistAsset } from './media';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('clippar.db');
    await initTables();
    await migrateEditorColumns();
  }
  return db;
}

async function initTables() {
  if (!db) return;
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS local_clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL,
      hole_number INTEGER NOT NULL,
      shot_number INTEGER NOT NULL,
      file_uri TEXT NOT NULL,
      gps_latitude REAL,
      gps_longitude REAL,
      duration_seconds REAL,
      timestamp TEXT NOT NULL,
      uploaded INTEGER DEFAULT 0,
      upload_retry_count INTEGER DEFAULT 0,
      remote_clip_id TEXT,
      trim_start_ms INTEGER DEFAULT 0,
      trim_end_ms INTEGER DEFAULT -1,
      is_excluded INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS local_rounds (
      id TEXT PRIMARY KEY,
      course_name TEXT NOT NULL,
      course_id TEXT,
      current_hole INTEGER DEFAULT 1,
      current_shot INTEGER DEFAULT 1,
      status TEXT DEFAULT 'in_progress',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS local_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL,
      hole_number INTEGER NOT NULL,
      strokes INTEGER NOT NULL,
      putts INTEGER DEFAULT 0,
      penalty_strokes INTEGER DEFAULT 0,
      is_pickup INTEGER DEFAULT 0,
      par INTEGER DEFAULT 4,
      UNIQUE(round_id, hole_number)
    );
  `);
}

// Migrate existing databases to add new columns
async function migrateEditorColumns() {
  if (!db) return;
  const migrations = [
    'ALTER TABLE local_clips ADD COLUMN trim_start_ms INTEGER DEFAULT 0',
    'ALTER TABLE local_clips ADD COLUMN trim_end_ms INTEGER DEFAULT -1',
    'ALTER TABLE local_clips ADD COLUMN is_excluded INTEGER DEFAULT 0',
    'ALTER TABLE local_clips ADD COLUMN sort_order INTEGER DEFAULT 0',
    // Auto-trim columns (Phase 1)
    'ALTER TABLE local_clips ADD COLUMN trimmed_file_uri TEXT',
    'ALTER TABLE local_clips ADD COLUMN original_file_uri TEXT',
    'ALTER TABLE local_clips ADD COLUMN auto_trimmed INTEGER DEFAULT 0',
    'ALTER TABLE local_clips ADD COLUMN trim_confidence REAL',
    'ALTER TABLE local_clips ADD COLUMN impact_time_ms REAL',
    // Lazy-trim flag (Phase 2: import saves URI only, editor trims later)
    'ALTER TABLE local_clips ADD COLUMN needs_trim INTEGER DEFAULT 0',
    // Auto-trim boundaries relative to original video (for full-timeline trimmer)
    'ALTER TABLE local_clips ADD COLUMN auto_trim_start_ms INTEGER',
    'ALTER TABLE local_clips ADD COLUMN auto_trim_end_ms INTEGER',
    // Shot type classification: 'swing' | 'putt' | null (unknown)
    "ALTER TABLE local_clips ADD COLUMN shot_type TEXT",
    // Last upload error (string) when background upload fails — surfaces a
    // "Retry upload" affordance in the library. NULL when no error.
    'ALTER TABLE local_clips ADD COLUMN upload_error TEXT',
    // Timestamp of most recent upload attempt (ISO string). Used to throttle
    // auto-retry so we don't burn battery on a clip that keeps failing.
    'ALTER TABLE local_clips ADD COLUMN last_upload_attempt_at TEXT',
    // Photos library asset id (iOS localIdentifier / Android uri). Captured
    // at import time (from picker) or at mirror time (from MediaLibrary
    // saveToLibraryAsync). Used by photosRecovery on reinstall to re-hydrate
    // clip files from the user's Photos library when they're missing on disk.
    'ALTER TABLE local_clips ADD COLUMN photos_asset_id TEXT',
    // Shot-tracer capture columns (config.tracer). Heading is the back-camera
    // optical-axis azimuth sampled once at recording start (tripod = constant);
    // is_true flags true vs magnetic north; calibration is iOS 0-3 compass
    // accuracy (0 = unusable). Pitch is the camera's downward tilt in degrees
    // (drives the per-clip horizon line). gps_accuracy_m is the horizontal
    // accuracy of THIS clip's fix (gates pairing + the dynamic carry floor).
    'ALTER TABLE local_clips ADD COLUMN camera_heading_deg REAL',
    'ALTER TABLE local_clips ADD COLUMN camera_heading_is_true INTEGER',
    'ALTER TABLE local_clips ADD COLUMN camera_heading_calibration INTEGER',
    'ALTER TABLE local_clips ADD COLUMN camera_pitch_deg REAL',
    'ALTER TABLE local_clips ADD COLUMN gps_accuracy_m REAL',
    // Shot-tracer output columns. tracer_file_uri is a NEW rendered file
    // (tracer_<UUID>.mp4) — the original/trimmed files are never rewritten.
    // tracer_status lifecycle: NULL -> 'pending' -> 'done'|'skipped'|'failed';
    // 'stale' whenever the clip's trim/file/pairing changes (re-rendered on
    // next editor open). tracer_meta is a JSON blob (method, carryM, deltaDeg,
    // skip reason, confidence flags).
    'ALTER TABLE local_clips ADD COLUMN tracer_file_uri TEXT',
    'ALTER TABLE local_clips ADD COLUMN tracer_status TEXT',
    'ALTER TABLE local_clips ADD COLUMN tracer_meta TEXT',
    'ALTER TABLE local_clips ADD COLUMN tracer_rendered_at TEXT',
    // Reel staleness flag — set to 1 whenever a clip in a round is edited
    // after the last successful compose. The round detail page shows a
    // "Re-compose reel" button when this is 1, so the user knows their
    // trim / reorder / exclude changes haven't been applied to the saved
    // reel yet.
    'ALTER TABLE local_rounds ADD COLUMN reel_stale INTEGER DEFAULT 0',
    // Round setup persisted per round so recovery restores the real round
    // shape (start hole + hole count) instead of assuming a full 18 from
    // hole 1. Both are needed by lastHoleOf() to know when the round ends;
    // start_hole also drives the editor/scorecard hole numbering for a
    // back-nine round (holes 10–18). Legacy rows read back as the defaults.
    'ALTER TABLE local_rounds ADD COLUMN start_hole INTEGER DEFAULT 1',
    'ALTER TABLE local_rounds ADD COLUMN holes_played INTEGER DEFAULT 18',
    // The round's scorecard (HoleData[] as JSON), captured at round start.
    // Without it, recoverRound restored a round with no pars and scored every
    // hole against DEFAULT_PAR 4 — silently discarding the user's custom
    // course scorecard the moment they resumed. Stored locally (not fetched)
    // so it survives with no signal, which is the on-course norm.
    'ALTER TABLE local_rounds ADD COLUMN course_holes TEXT',
    // Settings table
    `CREATE TABLE IF NOT EXISTS local_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    // Persistent queue of rounds/clips that need to be uploaded to Supabase
    // so the work survives app kill / restart / offline periods. Each row is
    // a round waiting to have its clips streamed up.
    `CREATE TABLE IF NOT EXISTS local_upload_queue (
      round_id TEXT PRIMARY KEY,
      course_name TEXT,
      mode TEXT DEFAULT 'local-only',
      status TEXT DEFAULT 'pending',
      last_error TEXT,
      attempt_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    // Owner of the round: the Supabase user id that created it. One db file
    // is shared by every account that signs in on this handset and sign-out
    // does not wipe it (see lib/localScope.ts for why it must not), so this
    // column is what stops the next account being offered the previous
    // account's unfinished round and its playable video. Nullable only for
    // rows written before this migration — those are claimed once, on first
    // read with a session (currentScopeUserId below). Clips and scores inherit
    // it through round_id.
    'ALTER TABLE local_rounds ADD COLUMN user_id TEXT',
  ];
  for (const sql of migrations) {
    try { await db.execAsync(sql + ';'); } catch {} // column/table already exists
  }
}

// ────────────────────────────────────────────────────────────
// Per-user scoping of the shared local database
// ────────────────────────────────────────────────────────────

/**
 * Last user id we successfully resolved this process. Used ONLY to answer a
 * transient getSession() failure (a Keychain-busy window, say) without hiding
 * a golfer's own round from them mid-round. It is overwritten with `null` on a
 * clean signed-out read, so it can never serve a departed user's id to the
 * next account: signing in as B necessarily produced a successful getSession
 * that set this to B.
 */
let lastKnownUserId: string | null = null;
let legacyRoundsClaimed = false;

async function sessionUserId(): Promise<string | null> {
  try {
    // Lazy require, matching this file's existing style (shot-detector), so
    // importing storage never drags the auth client in at module load.
    const { supabase } = require('./supabase') as typeof import('./supabase');
    const { data, error } = await supabase.auth.getSession();
    if (error) return lastKnownUserId;
    lastKnownUserId = data.session?.user?.id ?? null;
    return lastKnownUserId;
  } catch {
    return lastKnownUserId;
  }
}

/**
 * The signed-in user id, for callers outside this module that must scope a
 * `local_settings` entry to an account rather than the handset.
 *
 * `local_settings` has no owner column and most of it is genuinely device
 * preference (trim window, playback speed) that should survive a change of
 * account — so per-account entries are distinguished by KEY, the convention
 * `pro.status_cache.<userId>` established and `clips.bin.v1.<userId>` follows.
 * Callers must fail closed on null: one shared key is exactly the cross-account
 * leak `lib/localScope.ts` exists to prevent.
 *
 * ⚠️ **NOT SAFE AS AN OWNERSHIP GATE ON ITS OWN.** This can resolve to an
 * account other than the one currently signed in, so failing closed on null is
 * necessary and NOT sufficient — null is not the only failure mode. An earlier
 * version of this docstring claimed otherwise, and that was the sentence I
 * wrote before building four destructive gates on top of it.
 *
 * **Do not build a new destructive gate on this function**, and do not change
 * it, without first reading finding 32 in `org/cto/SECURITY-2026-08-30-unfixed.md`
 * in the private company-brain repo. The fix is known and written up there.
 * Do not pair any change with resetting `legacyRoundsClaimed` — that re-arms a
 * separate problem, also written up there.
 *
 * (Detail deliberately kept out of this file: it is public, and the finding is
 * unfixed and live in shipped code. Same rule as the report — see finding 44.)
 */
export async function currentSessionUserId(): Promise<string | null> {
  return sessionUserId();
}

/**
 * The round a clip belongs to, read off the clip itself.
 *
 * For callers deciding whether they may destroy a clip. `deleteLocalClip` is
 * `DELETE FROM local_clips WHERE id = ?` with no ownership predicate, so a
 * gate that validates a round id the CALLER supplied proves nothing about the
 * clip id it then deletes — the two are independent. This lets the gate be
 * built from the clip's real round instead.
 *
 * Deliberately unscoped: it returns the round id for any clip, and the caller
 * passes that to the scoped `getLocalRound` to decide. Returning null here for
 * a foreign clip would be indistinguishable from "no such clip".
 */
export async function getLocalClipRound(clipId: number): Promise<string | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ round_id: string }>(
    'SELECT round_id FROM local_clips WHERE id = ?',
    clipId
  );
  return row?.round_id ?? null;
}

/**
 * Resolve the signed-in user for a scoped read, claiming any pre-migration
 * rows for them first (see shouldClaimLegacyRows). Doing the backfill here —
 * on the read path — rather than in a background task means a scoped query can
 * never race ahead of it and report "no unfinished round" to the very user who
 * recorded one.
 */
async function currentScopeUserId(database: SQLite.SQLiteDatabase): Promise<string | null> {
  const userId = await sessionUserId();
  if (shouldClaimLegacyRows(userId, legacyRoundsClaimed)) {
    try {
      await database.runAsync(
        'UPDATE local_rounds SET user_id = ? WHERE user_id IS NULL',
        userId!
      );
      legacyRoundsClaimed = true;
    } catch {
      // Older schema without the column, or a locked db — retry on the next
      // read rather than latching the flag, so the rows aren't left orphaned.
    }
  }
  return userId;
}

export async function updateClipEditorState(
  clipId: number,
  updates: {
    trim_start_ms?: number;
    trim_end_ms?: number;
    is_excluded?: boolean;
    sort_order?: number;
    file_uri?: string;
    duration_seconds?: number;
    shot_type?: string;
  }
) {
  const database = await getDatabase();
  const fields: string[] = [];
  const values: (number | string)[] = [];

  // Read the current trim/file values BEFORE writing so the tracer
  // invalidation below can fire on real CHANGES only. The editor re-saves
  // identical trim values on every open (FIX #8 full-swing override), and
  // invalidating on those no-op writes destroyed every rendered tracer on
  // the next editor visit (field bug: clip 330 rendered DONE, then went
  // 'stale' minutes later without any user edit).
  let before: {
    trim_start_ms: number | null;
    trim_end_ms: number | null;
    file_uri: string | null;
  } | null = null;
  try {
    before = await database.getFirstAsync(
      'SELECT trim_start_ms, trim_end_ms, file_uri FROM local_clips WHERE id = ?',
      clipId
    );
  } catch {}

  if (updates.trim_start_ms !== undefined) {
    fields.push('trim_start_ms = ?');
    values.push(updates.trim_start_ms);
  }
  if (updates.trim_end_ms !== undefined) {
    fields.push('trim_end_ms = ?');
    values.push(updates.trim_end_ms);
  }
  if (updates.is_excluded !== undefined) {
    fields.push('is_excluded = ?');
    values.push(updates.is_excluded ? 1 : 0);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sort_order);
  }
  if (updates.file_uri !== undefined) {
    fields.push('file_uri = ?');
    values.push(updates.file_uri);
  }
  if (updates.duration_seconds !== undefined) {
    fields.push('duration_seconds = ?');
    values.push(updates.duration_seconds);
  }
  if (updates.shot_type !== undefined) {
    fields.push('shot_type = ?');
    values.push(updates.shot_type);
  }

  if (fields.length === 0) return;
  values.push(clipId);

  await database.runAsync(
    `UPDATE local_clips SET ${fields.join(', ')} WHERE id = ?`,
    ...values
  );

  // Tracer invalidation funnel: a file swap or trim change makes any rendered
  // tracer wrong (its arc was burned for the OLD file/timeline). Null the
  // tracer file and mark 'stale' so the next editor open re-renders it. All
  // trim-save paths (editor updateTrim, preview.tsx, ScoreCollection
  // handleTrimSave) land in this function, so this one hook covers them all.
  // CHANGED values only — re-saving identical values must not invalidate.
  const fileChanged =
    updates.file_uri !== undefined &&
    (before === null || updates.file_uri !== before.file_uri);
  const trimChanged =
    (updates.trim_start_ms !== undefined &&
      (before === null || updates.trim_start_ms !== before.trim_start_ms)) ||
    (updates.trim_end_ms !== undefined &&
      (before === null || updates.trim_end_ms !== before.trim_end_ms));
  if (fileChanged || trimChanged) {
    await staleClipTracer(database, clipId);
  }
}

/**
 * Best-effort tracer invalidation for one clip: clear tracer_file_uri, set
 * tracer_status='stale' (only when a tracer was ever attempted — NULL status
 * stays NULL) and delete the orphaned tracer_<UUID>.mp4 from caches. Never
 * throws — staleness must not fail the caller's edit.
 */
async function staleClipTracer(
  database: SQLite.SQLiteDatabase,
  clipId: number
): Promise<void> {
  try {
    const row = await database.getFirstAsync<{ tracer_file_uri: string | null }>(
      'SELECT tracer_file_uri FROM local_clips WHERE id = ?',
      clipId
    );
    await database.runAsync(
      `UPDATE local_clips SET tracer_file_uri = NULL, tracer_status = 'stale'
       WHERE id = ? AND (tracer_file_uri IS NOT NULL OR tracer_status IS NOT NULL)`,
      clipId
    );
    const oldUri = row?.tracer_file_uri;
    if (oldUri && oldUri.startsWith('file://')) {
      // Lazy require keeps this module free of the shot-detector native
      // dependency at load time (same import-cycle concern noted on
      // deleteLocalClip). Deletion is fire-and-forget.
      const shotDetector =
        require('../modules/shot-detector') as typeof import('../modules/shot-detector');
      shotDetector.deleteFile(oldUri).catch(() => {});
    }
  } catch {
    // Tracer columns may be missing on a failed migration — non-fatal.
  }
}

/**
 * Mark the IMMEDIATE same-hole predecessor's tracer stale. A clip's tracer
 * arc is anchored to its same-hole SUCCESSOR's GPS (landing spot), so when a
 * clip is deleted or moved to another hole, the clip just before it on that
 * hole gains a different successor and its rendered arc no longer matches.
 * Ordering matches getClipsForRound: (sort_order, shot_number) within a hole.
 */
async function markPredecessorTracerStale(
  database: SQLite.SQLiteDatabase,
  roundId: string,
  holeNumber: number,
  excludeClipId: number,
  sortOrder: number,
  shotNumber: number
): Promise<void> {
  try {
    const pred = await database.getFirstAsync<{ id: number }>(
      `SELECT id FROM local_clips
       WHERE round_id = ? AND hole_number = ? AND id != ?
         AND (sort_order < ? OR (sort_order = ? AND shot_number < ?))
       ORDER BY sort_order DESC, shot_number DESC
       LIMIT 1`,
      roundId,
      holeNumber,
      excludeClipId,
      sortOrder,
      sortOrder,
      shotNumber
    );
    if (pred) await staleClipTracer(database, pred.id);
  } catch {
    // Best-effort — never fail the caller's delete/move.
  }
}

/**
 * Persist shot-tracer output for a clip. Mirrors updateClipEditorState's
 * dynamic field list; explicit `null` writes SQL NULL (e.g. clearing
 * tracer_file_uri when marking a clip stale).
 */
export async function updateClipTracer(
  clipId: number,
  updates: {
    tracer_file_uri?: string | null;
    tracer_status?: string | null;
    tracer_meta?: string | null;
    tracer_rendered_at?: string | null;
  }
) {
  const database = await getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.tracer_file_uri !== undefined) {
    fields.push('tracer_file_uri = ?');
    values.push(updates.tracer_file_uri);
  }
  if (updates.tracer_status !== undefined) {
    fields.push('tracer_status = ?');
    values.push(updates.tracer_status);
  }
  if (updates.tracer_meta !== undefined) {
    fields.push('tracer_meta = ?');
    values.push(updates.tracer_meta);
  }
  if (updates.tracer_rendered_at !== undefined) {
    fields.push('tracer_rendered_at = ?');
    values.push(updates.tracer_rendered_at);
  }

  if (fields.length === 0) return;
  values.push(clipId);

  await database.runAsync(
    `UPDATE local_clips SET ${fields.join(', ')} WHERE id = ?`,
    ...values
  );
}

export async function saveLocalClip(clip: {
  round_id: string;
  hole_number: number;
  shot_number: number;
  file_uri: string;
  gps_latitude?: number;
  gps_longitude?: number;
  duration_seconds?: number;
  // Auto-trim metadata
  trimmed_file_uri?: string;
  original_file_uri?: string;
  auto_trimmed?: number;
  trim_confidence?: number;
  impact_time_ms?: number;
  trim_start_ms?: number;
  trim_end_ms?: number;
  needs_trim?: number;
  photos_asset_id?: string | null;
  // Shot-tracer capture metadata (config.tracer) — all optional/nullable so
  // existing callers and tracer-disabled builds are unaffected.
  camera_heading_deg?: number | null;
  camera_heading_is_true?: number | null;
  camera_heading_calibration?: number | null;
  camera_pitch_deg?: number | null;
  gps_accuracy_m?: number | null;
}): Promise<number> {
  const database = await getDatabase();
  const result = await database.runAsync(
    `INSERT INTO local_clips (round_id, hole_number, shot_number, file_uri, gps_latitude, gps_longitude, duration_seconds, timestamp, trimmed_file_uri, original_file_uri, auto_trimmed, trim_confidence, impact_time_ms, trim_start_ms, trim_end_ms, needs_trim, photos_asset_id, camera_heading_deg, camera_heading_is_true, camera_heading_calibration, camera_pitch_deg, gps_accuracy_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clip.round_id,
    clip.hole_number,
    clip.shot_number,
    clip.file_uri,
    clip.gps_latitude ?? null,
    clip.gps_longitude ?? null,
    clip.duration_seconds ?? null,
    new Date().toISOString(),
    clip.trimmed_file_uri ?? null,
    clip.original_file_uri ?? null,
    clip.auto_trimmed ?? 0,
    clip.trim_confidence ?? null,
    clip.impact_time_ms ?? null,
    clip.trim_start_ms ?? 0,
    clip.trim_end_ms ?? -1,
    clip.needs_trim ?? 0,
    clip.photos_asset_id ?? null,
    clip.camera_heading_deg ?? null,
    clip.camera_heading_is_true ?? null,
    clip.camera_heading_calibration ?? null,
    clip.camera_pitch_deg ?? null,
    clip.gps_accuracy_m ?? null,
  );
  return result.lastInsertRowId;
}

/**
 * Update a clip's photos_asset_id (after MediaLibrary.saveToLibraryAsync).
 */
export async function setClipPhotosAssetId(clipId: number, photosAssetId: string | null) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE local_clips SET photos_asset_id = ? WHERE id = ?',
    photosAssetId,
    clipId,
  );
}

/**
 * Return clips whose local file_uri is missing on disk but have a
 * photos_asset_id we can re-import from. Used by photosRecovery on launch.
 */
export async function getClipsWithPhotosAssetId() {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    file_uri: string;
    photos_asset_id: string | null;
  }>(
    `SELECT id, round_id, file_uri, photos_asset_id
     FROM local_clips
     WHERE photos_asset_id IS NOT NULL AND photos_asset_id != ''`
  );
}

/**
 * How many local clips are ACTUALLY in the user's Photos library.
 *
 * app/profile/storage-settings.tsx used to tick "Raw clips — mirrored to
 * Photos, will re-import on reinstall" off the toggle's position alone. That
 * is a claim about intent; this is a fact about footage. The two came apart
 * badly: until the record path was wired up, no recorded clip had an asset id
 * however the toggle was set — and even now, every clip captured BEFORE the
 * user switched it on is unrecoverable, which is most of a returning user's
 * history. Somebody deciding whether it is safe to wipe their phone is
 * reading that line.
 *
 * The `mirrored` predicate must stay identical to getClipsWithPhotosAssetId's
 * WHERE clause above — recovery is what "mirrored" means, so a count that
 * admits rows recovery would skip is the same lie in a new place.
 * tests/photosMirror.test.ts pins the two together.
 */
export async function getClipMirrorStats(): Promise<{
  total: number;
  mirrored: number;
}> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ total: number; mirrored: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN photos_asset_id IS NOT NULL AND photos_asset_id != '' THEN 1 ELSE 0 END) AS mirrored
     FROM local_clips`
  );
  return { total: row?.total ?? 0, mirrored: row?.mirrored ?? 0 };
}

// ────────────────────────────────────────────────────────────
// Storage-policy settings (mirror to Photos / cloud backup)
// ────────────────────────────────────────────────────────────

const SETTING_MIRROR_CLIPS = 'mirror_raw_clips_to_photos';
const SETTING_CLOUD_BACKUP = 'cloud_backup_enabled';

export async function getMirrorClipsToPhotos(): Promise<boolean> {
  return (await getSetting(SETTING_MIRROR_CLIPS)) === '1';
}

export async function setMirrorClipsToPhotos(enabled: boolean): Promise<void> {
  await setSetting(SETTING_MIRROR_CLIPS, enabled ? '1' : '0');
}

export async function getCloudBackupEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_CLOUD_BACKUP)) === '1';
}

export async function setCloudBackupEnabled(enabled: boolean): Promise<void> {
  await setSetting(SETTING_CLOUD_BACKUP, enabled ? '1' : '0');
}

// ────────────────────────────────────────────────────────────
// Reel staleness — set when clips change after last compose
// ────────────────────────────────────────────────────────────

/**
 * Mark this round's reel as stale (clips were edited after last compose).
 * The round detail page reads this to show a "Re-compose reel" button.
 */
export async function markReelStale(roundId: string): Promise<void> {
  if (!roundId) return;
  const database = await getDatabase();
  try {
    await database.runAsync(
      'UPDATE local_rounds SET reel_stale = 1 WHERE id = ?',
      roundId,
    );
  } catch {
    // local_rounds row may not exist for older rounds; not a real failure.
  }
}

/**
 * Clear the stale flag — call this after a successful compose so the
 * "Re-compose" button stops showing until the next clip edit.
 */
export async function markReelFresh(roundId: string): Promise<void> {
  if (!roundId) return;
  const database = await getDatabase();
  try {
    await database.runAsync(
      'UPDATE local_rounds SET reel_stale = 0 WHERE id = ?',
      roundId,
    );
  } catch {}
}

export async function isReelStale(roundId: string): Promise<boolean> {
  if (!roundId) return false;
  const database = await getDatabase();
  try {
    const row = await database.getFirstAsync<{ reel_stale: number | null }>(
      'SELECT reel_stale FROM local_rounds WHERE id = ?',
      roundId,
    );
    return (row?.reel_stale ?? 0) === 1;
  } catch {
    return false;
  }
}

// Settings helpers
export async function getSetting(key: string): Promise<string | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM local_settings WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const database = await getDatabase();
  if (value === null) {
    await database.runAsync('DELETE FROM local_settings WHERE key = ?', key);
    return;
  }
  await database.runAsync(
    'INSERT OR REPLACE INTO local_settings (key, value) VALUES (?, ?)',
    key,
    value
  );
}

export async function getUnuploadedClips(roundId: string) {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    gps_latitude: number | null;
    gps_longitude: number | null;
    timestamp: string;
  }>(
    'SELECT * FROM local_clips WHERE round_id = ? AND uploaded = 0 ORDER BY hole_number, shot_number',
    roundId
  );
}

export async function markClipUploaded(clipId: number, remoteClipId: string) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE local_clips SET uploaded = 1, remote_clip_id = ? WHERE id = ?',
    remoteClipId,
    clipId
  );
}

export async function getUnprocessedClips(roundId: string) {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    original_file_uri: string | null;
    duration_seconds: number | null;
  }>(
    'SELECT * FROM local_clips WHERE round_id = ? AND needs_trim = 1 AND auto_trimmed = 0 ORDER BY hole_number, shot_number',
    roundId
  );
}

/**
 * Promote a trim result onto the clip row.
 *
 * THE FILE IS PERSISTED BEFORE THE ROW POINTS AT IT. modules/shot-detector
 * exports its trim to `Library/Caches/trim_<uuid>` (ShotDetectorModule.swift),
 * and this function used to write that cache path straight into file_uri. From
 * that moment the trimmed clip — the one the editor plays, the compose reads
 * and the upload queue sends — was a file iOS could reclaim at any time, with
 * nothing to regenerate it: auto_trimmed=1 and needs_trim=0 mean the editor's
 * processAllUntrimmed pass will never look at that clip again. Every call site
 * that produces a trim (hooks/useCamera.ts, both batches in
 * hooks/useEditorState.ts) funnels through here, so this is the one place the
 * guarantee can be made for all of them.
 *
 * Calls that pass an already-durable original — putts and no-detection, which
 * keep the full clip — are unaffected: isPurgeableAppPath is false for a
 * documentDirectory path, so persistTrimOutput hands the uri straight back and
 * no file is touched.
 *
 * COPY, NOT MOVE — unlike the record path. hooks/useEditorState.ts assigns
 * `result.trimmedUri` to `updatedClip.sourceUri` and pushes it into React
 * state BEFORE calling this, so renaming that file away would leave the
 * mounted editor holding a path that no longer exists: preview and export
 * break until the screen is rebuilt from SQLite. Keeping the source means the
 * in-memory path stays valid for the rest of the session while the row gets
 * the durable copy, and no caller has to learn the new path. The cache
 * original is then unreferenced, so reclaimTemporaryExports ages it out on a
 * later launch — which is exactly what that sweep is for.
 */
async function persistTrimOutput(clipId: number, uri: string): Promise<string> {
  if (!isPurgeableAppPath(uri)) return uri;
  try {
    return await persistAsset(
      uri,
      `trimmed_${clipId}_${Date.now()}.${videoExtension(uri)}`,
      { keepSource: true }
    );
  } catch {
    // persistAsset already swallows its own failures; this is for the import
    // itself failing on a web/test build. Storing the cache path is what we
    // did before, and migrateLegacyUris will rescue the row at next launch.
    return uri;
  }
}

export async function markClipTrimmed(
  clipId: number,
  trimmedFileUri: string,
  impactTimeMs: number | null,
  trimConfidence: number | null,
  autoTrimStartMs: number | null = null,
  autoTrimEndMs: number | null = null,
) {
  const database = await getDatabase();
  // Read before writing: the outgoing trimmed_file_uri has to be unlinked (see
  // below) and the original tells us which files we must never touch.
  const before = await database.getFirstAsync<{
    trimmed_file_uri: string | null;
    original_file_uri: string | null;
  }>(
    'SELECT trimmed_file_uri, original_file_uri FROM local_clips WHERE id = ?',
    clipId
  );
  // The row is gone — "Delete last shot" landed while detection was running.
  // Returning before the persist matters: moving the trim into
  // documentDirectory/clips/ for a clip that no longer exists would strand it
  // there permanently, where nothing sweeps. Left in the cache, it is exactly
  // what reclaimTemporaryExports exists to age out.
  if (!before) return;

  const durableUri = await persistTrimOutput(clipId, trimmedFileUri);

  // Compute the trimmed file's duration so the editor's badge + compose
  // logic uses the right value. Without this update, duration_seconds
  // stays at the original (pre-trim) length and downstream code thinks
  // the clip is much longer than it actually is.
  const durationSeconds =
    autoTrimStartMs !== null && autoTrimEndMs !== null
      ? Math.max(0, (autoTrimEndMs - autoTrimStartMs) / 1000)
      : null;
  const written = await database.runAsync(
    `UPDATE local_clips SET
      file_uri = ?,
      trimmed_file_uri = ?,
      auto_trimmed = 1,
      needs_trim = 0,
      impact_time_ms = ?,
      trim_confidence = ?,
      auto_trim_start_ms = ?,
      auto_trim_end_ms = ?,
      duration_seconds = COALESCE(?, duration_seconds)
    WHERE id = ?`,
    durableUri,
    durableUri,
    impactTimeMs ?? null,
    trimConfidence ?? null,
    autoTrimStartMs ?? null,
    autoTrimEndMs ?? null,
    durationSeconds,
    clipId
  );

  // The precheck above is not enough on its own: the delete can also land
  // WHILE the copy is in flight, and then this UPDATE matches no row. The
  // durable copy would sit in documentDirectory/clips/ forever — outside the
  // cache sweeper's reach, belonging to a clip that no longer exists. Ask the
  // write itself, which is the only answer that accounts for the whole window.
  if (written.changes === 0) {
    if (durableUri !== trimmedFileUri) {
      try {
        const shotDetector =
          require('../modules/shot-detector') as typeof import('../modules/shot-detector');
        shotDetector.deleteFile(durableUri).catch(() => {});
      } catch {}
    }
    return;
  }

  // Unlink the trim this one supersedes. While trims lived in Library/Caches
  // this was free — reclaimTemporaryExports ages out any trim_ file no row
  // points at. Now that they are persisted into documentDirectory/clips/,
  // nothing sweeps them, so a clip re-trimmed three times would strand three
  // full-fidelity copies of the golfer's swing for the life of the install.
  //
  // Never the original: it is the only source a re-trim can work from, and
  // putts/no-detection rows legitimately have trimmed_file_uri === it. Same
  // fire-and-forget, lazily-required shape as staleClipTracer above, for the
  // same import-cycle reason.
  const superseded = before?.trimmed_file_uri;
  if (
    superseded &&
    superseded !== durableUri &&
    superseded !== before?.original_file_uri
  ) {
    try {
      const shotDetector =
        require('../modules/shot-detector') as typeof import('../modules/shot-detector');
      shotDetector.deleteFile(superseded).catch(() => {});
    } catch {
      // shot-detector unavailable (e.g. web build) — the row is already correct.
    }
  }
}

export async function getClipsForRound(roundId: string) {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    uploaded: number;
    timestamp: string;
    trim_start_ms: number;
    trim_end_ms: number;
    is_excluded: number;
    sort_order: number;
    duration_seconds: number | null;
    auto_trimmed: number;
    original_file_uri: string | null;
    needs_trim: number;
    auto_trim_start_ms: number | null;
    auto_trim_end_ms: number | null;
    // Shot-tracer pairing inputs + output (SELECT * already returns these;
    // typed here so useEditorState's batch can consume them).
    gps_latitude: number | null;
    gps_longitude: number | null;
    shot_type: string | null;
    impact_time_ms: number | null;
    camera_heading_deg: number | null;
    camera_heading_is_true: number | null;
    camera_heading_calibration: number | null;
    camera_pitch_deg: number | null;
    gps_accuracy_m: number | null;
    tracer_file_uri: string | null;
    tracer_status: string | null;
    tracer_meta: string | null;
  }>(
    'SELECT * FROM local_clips WHERE round_id = ? ORDER BY hole_number, sort_order, shot_number',
    roundId
  );
}

/**
 * Whether a clip row still exists. Used by the live-record detection
 * continuation: "Delete last shot" can remove a clip while its deferred
 * detectAndTrim is still running, and the classification must not be
 * applied (or fed to the putt→swing hole-advance detector) for a clip the
 * user already deleted.
 */
export async function clipExists(clipId: number): Promise<boolean> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ id: number }>(
    'SELECT id FROM local_clips WHERE id = ?',
    clipId
  );
  return !!row;
}

export async function saveLocalRound(round: {
  id: string;
  course_name: string;
  course_id?: string;
  // Round setup — persisted so recoverRound restores the real shape. Default
  // to the legacy behaviour (full 18 from hole 1) when a caller omits them.
  holes_played?: 9 | 18;
  start_hole?: 1 | 10;
  /** HoleData[] serialised as JSON — the round's pars. */
  course_holes?: string | null;
}) {
  const database = await getDatabase();
  const startHole = round.start_hole ?? 1;
  // Stamp the owner at creation. INSERT OR REPLACE rewrites the whole row, so
  // user_id MUST be in the column list — leaving it out would null the stamp
  // on every re-save and hand the round back to the unscoped state.
  const userId = await currentScopeUserId(database);
  if (!userId) {
    // A round should never be written without a session (every path into
    // recording is behind the auth gate), but if the session momentarily
    // can't be read we must not leave the row stamped with nobody and
    // therefore invisible to its own owner forever. Re-arm the one-time claim
    // so the next scoped read adopts it for whoever is actually signed in.
    legacyRoundsClaimed = false;
  }
  await database.runAsync(
    `INSERT OR REPLACE INTO local_rounds
       (id, course_name, course_id, started_at, holes_played, start_hole,
        course_holes, current_hole, current_shot, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    round.id,
    round.course_name,
    round.course_id ?? null,
    new Date().toISOString(),
    round.holes_played ?? 18,
    startHole,
    round.course_holes ?? null,
    // Seed the live pointers from the round's real starting hole. They used
    // to fall to the column DEFAULT 1, so a back-nine round (start hole 10)
    // was persisted as "hole 1" and Resume restored it on hole 1 — every
    // clip recorded after a resume was then tagged to the wrong hole, and
    // Previous Hole was disabled because currentHole (1) <= startHole (10).
    startHole,
    1,
    userId
  );
}

/**
 * Unfinished rounds to offer as "Resume" on the record tab.
 *
 * Scoped to the signed-in user: this read is what the next person to sign in
 * on a shared/handed-over handset sees, and unscoped it handed them the
 * previous golfer's round — course, scores, GPS and every raw swing video,
 * playable and exportable (see lib/localScope.ts). Two layers on purpose: the
 * SQL predicate, and an ownership filter on the rows that come back.
 */
export async function getOrphanedRounds() {
  const database = await getDatabase();
  const userId = await currentScopeUserId(database);
  const scope = ownedRoundsClause(userId);
  const rows = await database.getAllAsync<{
    id: string;
    course_name: string;
    status: string;
    started_at: string;
    user_id: string | null;
  }>(
    `SELECT * FROM local_rounds WHERE status = 'in_progress' AND ${scope.sql}`,
    ...scope.params
  );
  return rows.filter((r) => isRowVisible(r.user_id, userId));
}

/**
 * Load one local round. Scoped as well as getOrphanedRounds — this is what
 * recoverRound() and the editor hydrate from, so an id that leaked by any
 * other route (a share link, a stale nav param) still can't pull another
 * account's round off this device.
 */
export async function getLocalRound(roundId: string) {
  const database = await getDatabase();
  const userId = await currentScopeUserId(database);
  const scope = ownedRoundsClause(userId);
  const row = await database.getFirstAsync<{
    id: string;
    course_name: string;
    course_id: string | null;
    current_hole: number;
    current_shot: number;
    status: string;
    started_at: string;
    finished_at: string | null;
    // NULL for rounds created before the columns were added — recoverRound
    // normalizes those to the legacy default (18 / hole 1).
    holes_played: number | null;
    start_hole: number | null;
    user_id: string | null;
  }>(
    `SELECT * FROM local_rounds WHERE id = ? AND ${scope.sql}`,
    roundId,
    ...scope.params
  );
  return isRowVisible(row?.user_id, userId) ? row : null;
}

export async function updateLocalRound(
  id: string,
  updates: {
    current_hole?: number;
    current_shot?: number;
    status?: string;
    finished_at?: string;
  }
) {
  const database = await getDatabase();
  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (updates.current_hole !== undefined) {
    fields.push('current_hole = ?');
    values.push(updates.current_hole);
  }
  if (updates.current_shot !== undefined) {
    fields.push('current_shot = ?');
    values.push(updates.current_shot);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(updates.finished_at);
  }

  if (fields.length === 0) return;
  values.push(id);

  await database.runAsync(
    `UPDATE local_rounds SET ${fields.join(', ')} WHERE id = ?`,
    ...values
  );
}

export async function saveLocalScore(score: {
  round_id: string;
  hole_number: number;
  strokes: number;
  putts: number;
  penalty_strokes: number;
  is_pickup: boolean;
  par: number;
}) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT OR REPLACE INTO local_scores (round_id, hole_number, strokes, putts, penalty_strokes, is_pickup, par)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    score.round_id,
    score.hole_number,
    score.strokes,
    score.putts,
    score.penalty_strokes,
    score.is_pickup ? 1 : 0,
    score.par
  );
}

export async function getLocalScores(roundId: string) {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    strokes: number;
    putts: number;
    penalty_strokes: number;
    is_pickup: number;
    par: number;
  }>(
    'SELECT * FROM local_scores WHERE round_id = ? ORDER BY hole_number',
    roundId
  );
}

export async function incrementClipRetryCount(clipId: number) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE local_clips SET upload_retry_count = upload_retry_count + 1 WHERE id = ?',
    clipId
  );
}

export async function getClipsForMultipleRounds(roundIds: string[]) {
  if (roundIds.length === 0) return [];
  const database = await getDatabase();
  const placeholders = roundIds.map(() => '?').join(',');
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    trim_start_ms: number;
    trim_end_ms: number;
    duration_seconds: number | null;
    auto_trimmed: number;
    original_file_uri: string | null;
    auto_trim_start_ms: number | null;
    auto_trim_end_ms: number | null;
  }>(
    `SELECT * FROM local_clips WHERE round_id IN (${placeholders}) ORDER BY round_id, hole_number, shot_number`,
    ...roundIds
  );
}

export async function deleteLocalRound(roundId: string) {
  const database = await getDatabase();

  // Collect every on-disk clip file for this round BEFORE dropping the rows.
  // Each clip can carry up to four file:// URIs (raw / trimmed / original /
  // tracer). Without this, deleting an 18-hole round leaks tens–hundreds of
  // MB permanently. Best-effort: a missing column or file must never throw.
  let fileUris: string[] = [];
  try {
    const rows = await database.getAllAsync<{
      file_uri: string | null;
      trimmed_file_uri: string | null;
      original_file_uri: string | null;
      tracer_file_uri: string | null;
    }>(
      'SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri FROM local_clips WHERE round_id = ?',
      roundId
    );
    fileUris = [
      ...new Set(
        rows
          .flatMap((r) => [
            r.file_uri,
            r.trimmed_file_uri,
            r.original_file_uri,
            r.tracer_file_uri,
          ])
          .filter((u): u is string => !!u && u.startsWith('file://'))
      ),
    ];
  } catch {
    // Older schemas may lack the editor columns — non-fatal, rows still drop.
  }

  await database.runAsync('DELETE FROM local_scores WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_clips WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_rounds WHERE id = ?', roundId);
  await database.runAsync('DELETE FROM local_upload_queue WHERE round_id = ?', roundId);

  // Unlink the underlying video files now their rows are gone. Lazy require
  // keeps this module free of the shot-detector native dependency at load time
  // (same import-cycle concern as deleteLocalClip / staleClipTracer). Each
  // delete is fire-and-forget so a missing file can't wedge or throw.
  if (fileUris.length > 0) {
    try {
      const shotDetector =
        require('../modules/shot-detector') as typeof import('../modules/shot-detector');
      for (const uri of fileUris) {
        shotDetector.deleteFile(uri).catch(() => {});
      }
    } catch {
      // shot-detector unavailable (e.g. web build) — rows are already gone.
    }
  }
}

/**
 * Delete a single clip row (used by the recording screen's "Delete last
 * shot" action). Returns the clip's local file URIs so the caller can
 * best-effort delete the underlying video files. We DON'T delete the
 * files here to keep this module free of the shot-detector native
 * dependency (avoids an import cycle) — file cleanup is the caller's job.
 *
 * Also pulls the clip out of the upload queue so a just-deleted shot
 * doesn't get pushed to Storage after the fact.
 *
 * Returns `row` — the ENTIRE deleted record — so the caller can hand it to
 * restoreLocalClip() and undo the delete. A caller that intends to offer
 * undo must therefore NOT delete the returned fileUris until the undo
 * window closes; the video files are what make a restore meaningful.
 */
export async function deleteLocalClip(
  clipId: number,
  // When the caller offers UNDO, it passes false: staling the same-hole
  // predecessor's tracer is irreversible (it nulls the column AND unlinks the
  // rendered file), so doing it at delete time would make a subsequent restore
  // silently degrade the neighbouring clip. The caller instead commits the
  // stale later — on undo-stack eviction / round end — via commitClipDeletion.
  stalePredecessor = true
): Promise<{ fileUris: string[]; row: LocalClipRow | null }> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<LocalClipRow>(
    'SELECT * FROM local_clips WHERE id = ?',
    clipId
  );
  // The deleted clip's same-hole predecessor paired with THIS clip's GPS as
  // its landing spot — its tracer no longer matches. Mark it stale before
  // the row disappears (unless the caller defers it for an undo window).
  if (row && stalePredecessor) {
    await markPredecessorTracerStale(
      database,
      row.round_id,
      row.hole_number,
      clipId,
      row.sort_order,
      row.shot_number
    );
  }
  await database.runAsync('DELETE FROM local_clips WHERE id = ?', clipId);
  // Best-effort: a clip that was already queued for upload shouldn't fire
  // after deletion. The queue is keyed by round_id + clip metadata, so we
  // can't target a single clip precisely here, but leaving the row out of
  // local_clips means the queue processor skips it (it joins on clip rows).

  const fileUris = [
    row?.file_uri,
    row?.trimmed_file_uri,
    row?.original_file_uri,
    row?.tracer_file_uri,
  ].filter((u): u is string => !!u && u.startsWith('file://'));
  // De-dupe (trimmed often === file_uri) so we don't try to delete twice.
  return { fileUris: [...new Set(fileUris)], row: row ?? null };
}

/**
 * Finalise a deletion that was made with `stalePredecessor = false` (i.e. an
 * undoable delete whose undo window has now closed — the entry was evicted
 * from the stack, or the round ended). Applies the same-hole predecessor
 * tracer invalidation that deleteLocalClip deferred, using the deleted row's
 * own metadata (its DB row is already gone, so we work from the captured row).
 * No-op today because tracers are prod-disabled; correct for when they ship.
 */
export async function commitClipDeletion(row: LocalClipRow): Promise<void> {
  try {
    const database = await getDatabase();
    await markPredecessorTracerStale(
      database,
      row.round_id,
      row.hole_number,
      row.id,
      row.sort_order,
      row.shot_number
    );
  } catch {
    // Best-effort — never throw from a cleanup path.
  }
}

/**
 * A full local_clips record, as returned by `SELECT *`. The columns the code
 * actually reaches for are typed; the index signature covers the rest (the
 * table has ~30 columns, all of which restoreLocalClip round-trips verbatim).
 */
export type LocalClipRow = {
  id: number;
  round_id: string;
  hole_number: number;
  shot_number: number;
  sort_order: number;
  file_uri: string | null;
  trimmed_file_uri: string | null;
  original_file_uri: string | null;
  tracer_file_uri: string | null;
  [column: string]: unknown;
};

/**
 * Re-insert a clip row that deleteLocalClip() removed, preserving its
 * original primary key so anything holding that id (round state, the
 * editor, the upload queue) lines back up. Powers "Undo delete" on the
 * recording screen.
 *
 * ⚠️ **Column names are interpolated into the INSERT unescaped** — SQLite has no
 * placeholder for an identifier, so they cannot be bound. Values are bound;
 * identifiers are spliced.
 *
 * This used to say the identifiers are DB-controlled because the row came
 * straight from a `SELECT *`. **That is no longer true and it is my change that
 * broke it:** `lib/clipBin.ts` persists whole rows as JSON in `local_settings`
 * and hands them back after a `JSON.parse`, so the keys are only as trustworthy
 * as that blob.
 *
 * So the identifier check now lives HERE, at the sink that does the splicing,
 * instead of resting on one caller's discipline. It was deferred once on the
 * grounds that moving it changes a shared primitive with a caller outside the
 * diff. That premise was wrong and checking it took one command: all three
 * call sites pass rows originating in `SELECT * FROM local_clips`, and every
 * column in that table's schema plus its 25 `ALTER TABLE` migrations is plain
 * snake_case. No existing caller's behaviour changes; what changes is that the
 * next one cannot get it wrong silently.
 *
 * A rejected key THROWS rather than returning false, and that is not a style
 * choice. `false` already means "a row with that id exists, so there is
 * nothing to undo", and `restoreClipFromBin` acts on it by dropping the bin
 * entry — correct when the clip is back in the table, destructive if `false`
 * could also mean "I refused". Throwing leaves the entry in the bin.
 *
 * Returns false if a row with that id already exists (nothing to undo).
 */
export const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function restoreLocalClip(row: LocalClipRow): Promise<boolean> {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<{ id: number }>(
    'SELECT id FROM local_clips WHERE id = ?',
    row.id
  );
  if (existing) return false;

  const columns = Object.keys(row);
  if (columns.length === 0) return false;
  // Checked against the identifier SHAPE, not an allow-list of known columns:
  // `local_clips` grows by ALTER TABLE, so a hardcoded list would drift and
  // start refusing valid restores. The shape is what closes the splice; an
  // unknown-but-well-formed column still fails at INSERT, harmlessly.
  if (!columns.every((c) => SQL_IDENTIFIER.test(c))) {
    throw new Error('restoreLocalClip: refusing to splice a non-identifier column name');
  }
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((c) => (row[c] as never) ?? null);

  await database.runAsync(
    `INSERT INTO local_clips (${columns.join(', ')}) VALUES (${placeholders})`,
    ...values
  );
  return true;
}

/**
 * Wipe a round's clips + scores but KEEP the round row. Used by the
 * recording-screen clicker tutorial, which practices on the REAL round
 * (so the user sees real recording / hole changes / penalties) and then
 * resets it to a clean slate when the tutorial finishes — "as if no
 * videos were taken, just like the start of the round."
 *
 * Returns the deleted clips' local file URIs so the caller can best-effort
 * delete the underlying video files. (In practice mode the camera discards
 * clips before they're saved, so this usually finds nothing — but we clear
 * defensively in case any slipped through.)
 */
export async function resetRoundData(
  roundId: string
): Promise<{ fileUris: string[] }> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    file_uri: string | null;
    trimmed_file_uri: string | null;
    original_file_uri: string | null;
    tracer_file_uri: string | null;
  }>(
    'SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri FROM local_clips WHERE round_id = ?',
    roundId
  );
  await database.runAsync('DELETE FROM local_clips WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_scores WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_upload_queue WHERE round_id = ?', roundId);
  const fileUris = rows
    .flatMap((r) => [r.file_uri, r.trimmed_file_uri, r.original_file_uri, r.tracer_file_uri])
    .filter((u): u is string => !!u && u.startsWith('file://'));
  return { fileUris: [...new Set(fileUris)] };
}

/**
 * Reassign a clip to a different hole (used by the scorecard screen's
 * "Move to hole" action). Updates hole_number and resets shot_number to
 * the end of the destination hole so ordering stays sane. Marks the
 * round's reel stale since the composed sequence changed.
 */
export async function updateClipHole(
  clipId: number,
  newHoleNumber: number,
  roundId: string
): Promise<void> {
  const database = await getDatabase();
  // Tracer pairing is (hole, order)-based, so a hole move invalidates three
  // arcs: the OLD hole's predecessor (lost this clip as its landing GPS),
  // the moved clip itself (gets a different successor on the new hole), and
  // the clip it lands after on the NEW hole (gains it as successor). All
  // best-effort and no-ops while tracers are unrendered.
  const oldPos = await database
    .getFirstAsync<{ hole_number: number; sort_order: number; shot_number: number }>(
      'SELECT hole_number, sort_order, shot_number FROM local_clips WHERE id = ?',
      clipId
    )
    .catch(() => null);
  if (oldPos) {
    await markPredecessorTracerStale(
      database,
      roundId,
      oldPos.hole_number,
      clipId,
      oldPos.sort_order,
      oldPos.shot_number
    );
  }
  await staleClipTracer(database, clipId);
  const lastOnTarget = await database
    .getFirstAsync<{ id: number }>(
      'SELECT id FROM local_clips WHERE round_id = ? AND hole_number = ? AND id != ? ORDER BY sort_order DESC, shot_number DESC LIMIT 1',
      roundId,
      newHoleNumber,
      clipId
    )
    .catch(() => null);
  if (lastOnTarget) await staleClipTracer(database, lastOnTarget.id);
  // Place the moved clip after the last existing shot on the target hole.
  const maxRow = await database.getFirstAsync<{ max_shot: number | null }>(
    'SELECT MAX(shot_number) AS max_shot FROM local_clips WHERE round_id = ? AND hole_number = ?',
    roundId,
    newHoleNumber
  );
  const nextShot = (maxRow?.max_shot ?? 0) + 1;
  await database.runAsync(
    'UPDATE local_clips SET hole_number = ?, shot_number = ? WHERE id = ?',
    newHoleNumber,
    nextShot,
    clipId
  );
  await markReelStale(roundId).catch(() => {});
}

// ---- Upload error tracking ----

export async function markClipUploadError(clipId: number, errorMessage: string) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE local_clips SET upload_error = ?, last_upload_attempt_at = ? WHERE id = ?',
    errorMessage.slice(0, 500), // cap length
    new Date().toISOString(),
    clipId
  );
}

export async function clearClipUploadError(clipId: number) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE local_clips SET upload_error = NULL WHERE id = ?',
    clipId
  );
}

export async function getClipsWithUploadErrors(roundId?: string) {
  const database = await getDatabase();
  if (roundId) {
    return database.getAllAsync<{
      id: number;
      round_id: string;
      hole_number: number;
      shot_number: number;
      file_uri: string;
      upload_error: string;
      upload_retry_count: number;
      last_upload_attempt_at: string | null;
    }>(
      'SELECT * FROM local_clips WHERE round_id = ? AND upload_error IS NOT NULL AND uploaded = 0',
      roundId
    );
  }
  return database.getAllAsync<{
    id: number;
    round_id: string;
    hole_number: number;
    shot_number: number;
    file_uri: string;
    upload_error: string;
    upload_retry_count: number;
    last_upload_attempt_at: string | null;
  }>(
    'SELECT * FROM local_clips WHERE upload_error IS NOT NULL AND uploaded = 0'
  );
}

// ---- Upload queue (rounds to auto-upload in background) ----

export async function enqueueRoundForUpload(
  roundId: string,
  courseName: string | null,
  mode: 'local-only' | 'highlight-reel' = 'local-only'
) {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.runAsync(
    `INSERT INTO local_upload_queue (round_id, course_name, mode, status, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)
     ON CONFLICT(round_id) DO UPDATE SET
       course_name = excluded.course_name,
       mode = excluded.mode,
       status = 'pending',
       last_error = NULL,
       updated_at = excluded.updated_at`,
    roundId,
    courseName,
    mode,
    now,
    now
  );
}

/**
 * Rounds still waiting to back up. Scoped through their round's owner.
 *
 * This is not just a read-side leak: uploadQueue.processUploadQueue() takes
 * whatever this returns and calls uploadRoundClips(roundId, <currently signed-in
 * user>.id). Unscoped, a round user A queued before signing out was uploaded
 * into user B's Supabase account the moment B connected — A's swing video
 * copied into a stranger's cloud storage and attributed to them. The queue has
 * no owner column of its own; it inherits ownership from local_rounds, which
 * every queued round has (uploadQueue only enqueues rounds created through
 * saveLocalRound).
 */
export async function getQueuedRoundUploads() {
  const database = await getDatabase();
  const userId = await currentScopeUserId(database);
  const scope = ownedRoundsClause(userId);
  return database.getAllAsync<{
    round_id: string;
    course_name: string | null;
    mode: string;
    status: string;
    last_error: string | null;
    attempt_count: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT * FROM local_upload_queue
      WHERE status IN ('pending', 'error')
        AND round_id IN (SELECT id FROM local_rounds WHERE ${scope.sql})
      ORDER BY created_at`,
    ...scope.params
  );
}

export async function markQueuedRoundStatus(
  roundId: string,
  status: 'pending' | 'in_progress' | 'done' | 'error',
  errorMessage?: string | null
) {
  const database = await getDatabase();
  const now = new Date().toISOString();
  if (status === 'error') {
    await database.runAsync(
      `UPDATE local_upload_queue
       SET status = ?, last_error = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE round_id = ?`,
      status,
      errorMessage?.slice(0, 500) ?? null,
      now,
      roundId
    );
  } else {
    await database.runAsync(
      `UPDATE local_upload_queue SET status = ?, last_error = NULL, updated_at = ? WHERE round_id = ?`,
      status,
      now,
      roundId
    );
  }
}

export async function removeQueuedRoundUpload(roundId: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM local_upload_queue WHERE round_id = ?', roundId);
}

// ---- Legacy URI migration ----

/**
 * Return all local_clips rows whose file_uri or original_file_uri points at
 * a location iOS will purge (ph://, assets-library://, or any path under
 * /tmp/). These need to be resolved to a durable file:// path on next load.
 */
export async function getClipsWithLegacyUris() {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: number;
    round_id: string;
    file_uri: string;
    original_file_uri: string | null;
    trimmed_file_uri: string | null;
  }>(
    // The WHERE clause is GENERATED from lib/clipPaths, which is also what
    // lib/uriMigration.ts asks about each row it gets back. It used to be a
    // hand-written list of the same four patterns, and it fell one behind:
    // the app's own footage — recordings in `Library/Caches/…/Camera/` and
    // trims in `Library/Caches/trim_…` — was never selected, so the migration
    // could not rescue the clips with no second copy anywhere. Extending the
    // predicate without extending the query would have left the fix
    // unreachable — hence the shared source.
    //
    // trimmed_file_uri is selected but NOT matched on: it is a duplicate of
    // file_uri (markClipTrimmed writes both), so a row that needs it rescued
    // is always already selected by file_uri. It comes along so the migration
    // can keep the two columns in step instead of leaving one pointing into a
    // directory it just emptied.
    `SELECT id, round_id, file_uri, original_file_uri, trimmed_file_uri
     FROM local_clips
     WHERE ${evictableUriSql('file_uri')}
        OR ${evictableUriSql('original_file_uri')}`
  );
}

export async function updateClipFileUris(
  clipId: number,
  fileUri: string,
  originalFileUri?: string | null,
  trimmedFileUri?: string | null
) {
  const database = await getDatabase();
  // Built from whichever columns the caller actually resolved. The previous
  // two-branch version could not express "file_uri and trimmed_file_uri but
  // not original_file_uri", which is the shape a trimmed clip needs.
  const sets: string[] = ['file_uri = ?'];
  const params: (string | null)[] = [fileUri];
  if (originalFileUri !== undefined) {
    sets.push('original_file_uri = ?');
    params.push(originalFileUri);
  }
  if (trimmedFileUri !== undefined) {
    sets.push('trimmed_file_uri = ?');
    params.push(trimmedFileUri);
  }
  await database.runAsync(
    `UPDATE local_clips SET ${sets.join(', ')} WHERE id = ?`,
    ...params,
    clipId
  );
}

// (Generic key/value settings live earlier in this file against the
// local_settings table. Onboarding flags reuse those — no separate
// app_settings table needed.)

/**
 * Round ids belonging to the signed-in user. Backs the explicit, user-initiated
 * "remove my videos from this phone" action (lib/localWipe.ts) — deliberately
 * scoped, so that action can never reach into another account's rounds.
 * Returns [] when no session can be resolved: with no known owner we delete
 * nothing rather than everything.
 */
export async function listLocalRoundIdsForCurrentUser(): Promise<string[]> {
  const database = await getDatabase();
  const userId = await currentScopeUserId(database);
  const scope = ownedRoundsClause(userId);
  try {
    const rows = await database.getAllAsync<{ id: string; user_id: string | null }>(
      `SELECT id, user_id FROM local_rounds WHERE ${scope.sql}`,
      ...scope.params
    );
    return rows.filter((r) => isRowVisible(r.user_id, userId)).map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * Wipe every local table. Used by account deletion so a fresh sign-in (or a
 * different user on the same device) starts from a clean slate — no leftover
 * clips, rounds, scores, queued uploads, or settings from the deleted account.
 *
 * We DELETE rows rather than dropping the database file so the open handle
 * stays valid and the schema survives for the next user. Best-effort per
 * table: a missing table (older/failed migration) must not abort the wipe.
 *
 * The URI harvest is NOT optional. Dropping local_clips destroys the only
 * record of where the video lives, so a wipe that deletes rows first leaves
 * every raw clip in documentDirectory/clips/ forever: invisible to the app,
 * unreachable by any UI, still counted against the user's storage and still
 * copied into every subsequent iCloud backup — after we told them "everything
 * in your Clippar account is erased forever". Mirrors deleteLocalRound above.
 */
export async function clearLocalDatabase(): Promise<void> {
  const database = await getDatabase();

  // SCOPED TO ONE ACCOUNT. This was an unqualified `DELETE FROM` over every
  // table, plus deleteFile() on every clip URI in the database. On a phone two
  // golfers share — a clubhouse loaner, a partner's handset — user A deleting
  // THEIR account destroyed user B's rounds and unlinked B's raw video. That is
  // the worst outcome this product has: a round is recorded once, on a course,
  // and cannot be re-recorded. Wiping the deleting user's data must never reach
  // anyone else's.
  //
  // `local_rounds.user_id` is the ownership anchor; clips, scores and queued
  // uploads hang off `round_id`, so they scope through it. Resolved here rather
  // than passed in, so there is one way to answer "who is this" and callers
  // cannot get it wrong (same as listLocalRoundIdsForCurrentUser above).
  const ownerUserId = await currentScopeUserId(database);
  if (!ownerUserId) {
    // Fail CLOSED. With no resolvable session we cannot tell whose rows these
    // are, and deleting nothing is the right answer — wipeLocalUserData's
    // directory sweep is still a backstop for orphaned files, and data left on
    // a device its owner still controls is a far smaller harm than destroying a
    // second user's irreplaceable footage. Failing open here is precisely the
    // bug described above.
    console.warn('[storage] clearLocalDatabase: no resolvable owner — refusing to wipe');
    return;
  }

  const ownedRounds = 'SELECT id FROM local_rounds WHERE user_id = ?';

  let fileUris: string[] = [];
  try {
    const rows = await database.getAllAsync<{
      file_uri: string | null;
      trimmed_file_uri: string | null;
      original_file_uri: string | null;
      tracer_file_uri: string | null;
    }>(
      `SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri
         FROM local_clips WHERE round_id IN (${ownedRounds})`,
      [ownerUserId]
    );
    fileUris = [
      ...new Set(
        rows
          .flatMap((r) => [
            r.file_uri,
            r.trimmed_file_uri,
            r.original_file_uri,
            r.tracer_file_uri,
          ])
          .filter((u): u is string => !!u && u.startsWith('file://'))
      ),
    ];
  } catch {
    // Older schemas may lack the editor columns — non-fatal, rows still drop
    // and localWipe's directory sweep is the backstop for the files.
  }

  // Children first, then the rounds they hang off — otherwise the subquery that
  // identifies them has nothing left to match.
  const scopedDeletes: Array<[string, string[]]> = [
    [`DELETE FROM local_clips        WHERE round_id IN (${ownedRounds})`, [ownerUserId]],
    [`DELETE FROM local_scores       WHERE round_id IN (${ownedRounds})`, [ownerUserId]],
    [`DELETE FROM local_upload_queue WHERE round_id IN (${ownedRounds})`, [ownerUserId]],
    ['DELETE FROM local_rounds       WHERE user_id = ?', [ownerUserId]],
    // local_settings is keyed by name with no owner column, and most of it is
    // device preference (trim window, playback speed) that belongs to the
    // handset rather than the account — wiping it would reset the OTHER user's
    // app. The one genuinely per-account entry is the Pro cache, which
    // subscription.ts keys as `pro.status_cache.<userId>`, so remove exactly
    // that and leave the rest alone.
    ['DELETE FROM local_settings     WHERE key = ?', [`pro.status_cache.${ownerUserId}`]],
    // Same reasoning, second per-account entry: the recently-deleted clip bin
    // (lib/clipBin.ts, keyed `clips.bin.v1.<userId>`) holds whole clip rows for
    // this user. This drops the metadata only — and the files are unlinked by
    // `purgeAllBinnedClips`, which `wipeLocalUserData` now calls BEFORE this.
    //
    // That ordering is load-bearing, so do not reorder it: once this row is
    // gone, nothing names those files. Two earlier versions of this comment
    // were wrong in opposite directions — one claimed a bin walk that did not
    // exist, and its correction then leaned on `removeOwnedMediaDirectories`'
    // wholesale clips/ sweep instead. That sweep is unscoped (an escalated
    // HIGH), so scoping it correctly would have silently orphaned these files.
    // The purge call is what makes this true by construction rather than by
    // depending on a bug staying unfixed.
    ['DELETE FROM local_settings     WHERE key = ?', [`clips.bin.v1.${ownerUserId}`]],
    // The PRE-SCOPING bin key (`clips.bin.v1`, no user suffix) is deliberately
    // NOT deleted here. An earlier version of this list dropped it outright,
    // which contradicted the rule clipBin's own `drainLegacyBin` establishes in
    // the same breath: that row is DEVICE-WIDE, so acting on it wholesale
    // destroys the other account's entries. A blanket delete under B loses A's
    // recovery records with no undo AND orphans the files they pinned, because
    // nothing can reach them once the metadata is gone. `drainLegacyBin`
    // partitions it by round ownership instead — this account's entries purged
    // and their files unlinked, everyone else's written back for them to drain
    // when they next sign in — and that is the only correct treatment.
    //
    // The tutorial's active-round marker. app/_layout only runs the tutorial
    // sweep when this is EMPTY, so an account that signs out mid-tutorial would
    // leave it set and silently disable tutorial cleanup for every account
    // afterwards. It is device-wide and owner-less, so it may hold a round
    // belonging to a DIFFERENT account than the one being wiped — clearing it
    // is still right, because the sweep no longer takes candidates from it, so
    // the worst case is one uncollected tutorial round rather than a delete.
    ['DELETE FROM local_settings     WHERE key = ?', ['tutorial.active_round']],
  ];
  for (const [sql, params] of scopedDeletes) {
    try {
      await database.runAsync(sql, params);
    } catch {
      // Table may not exist on a partially-migrated db — keep going.
    }
  }

  // Unlink the videos now their rows are gone. Lazy require keeps this module
  // free of the shot-detector native dependency at load time (same import-cycle
  // concern as deleteLocalRound); each delete is fire-and-forget so a missing
  // file can't wedge or throw.
  if (fileUris.length > 0) {
    try {
      const shotDetector =
        require('../modules/shot-detector') as typeof import('../modules/shot-detector');
      for (const uri of fileUris) {
        shotDetector.deleteFile(uri).catch(() => {});
      }
    } catch {
      // shot-detector unavailable (e.g. web build) — rows are already gone.
    }
  }
}

