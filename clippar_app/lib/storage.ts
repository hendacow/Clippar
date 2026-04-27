import * as SQLite from 'expo-sqlite';

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
    // Reel staleness flag — set to 1 whenever a clip in a round is edited
    // after the last successful compose. The round detail page shows a
    // "Re-compose reel" button when this is 1, so the user knows their
    // trim / reorder / exclude changes haven't been applied to the saved
    // reel yet.
    'ALTER TABLE local_rounds ADD COLUMN reel_stale INTEGER DEFAULT 0',
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
  ];
  for (const sql of migrations) {
    try { await db.execAsync(sql + ';'); } catch {} // column/table already exists
  }
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
}): Promise<number> {
  const database = await getDatabase();
  const result = await database.runAsync(
    `INSERT INTO local_clips (round_id, hole_number, shot_number, file_uri, gps_latitude, gps_longitude, duration_seconds, timestamp, trimmed_file_uri, original_file_uri, auto_trimmed, trim_confidence, impact_time_ms, trim_start_ms, trim_end_ms, needs_trim, photos_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export async function markClipTrimmed(
  clipId: number,
  trimmedFileUri: string,
  impactTimeMs: number | null,
  trimConfidence: number | null,
  autoTrimStartMs: number | null = null,
  autoTrimEndMs: number | null = null,
) {
  const database = await getDatabase();
  // Compute the trimmed file's duration so the editor's badge + compose
  // logic uses the right value. Without this update, duration_seconds
  // stays at the original (pre-trim) length and downstream code thinks
  // the clip is much longer than it actually is.
  const durationSeconds =
    autoTrimStartMs !== null && autoTrimEndMs !== null
      ? Math.max(0, (autoTrimEndMs - autoTrimStartMs) / 1000)
      : null;
  await database.runAsync(
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
    trimmedFileUri,
    trimmedFileUri,
    impactTimeMs ?? null,
    trimConfidence ?? null,
    autoTrimStartMs ?? null,
    autoTrimEndMs ?? null,
    durationSeconds,
    clipId
  );
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
  }>(
    'SELECT * FROM local_clips WHERE round_id = ? ORDER BY hole_number, sort_order, shot_number',
    roundId
  );
}

export async function saveLocalRound(round: {
  id: string;
  course_name: string;
  course_id?: string;
}) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT OR REPLACE INTO local_rounds (id, course_name, course_id, started_at)
     VALUES (?, ?, ?, ?)`,
    round.id,
    round.course_name,
    round.course_id ?? null,
    new Date().toISOString()
  );
}

export async function getOrphanedRounds() {
  const database = await getDatabase();
  return database.getAllAsync<{
    id: string;
    course_name: string;
    status: string;
    started_at: string;
  }>(
    "SELECT * FROM local_rounds WHERE status = 'in_progress'"
  );
}

export async function getLocalRound(roundId: string) {
  const database = await getDatabase();
  return database.getFirstAsync<{
    id: string;
    course_name: string;
    course_id: string | null;
    current_hole: number;
    current_shot: number;
    status: string;
    started_at: string;
    finished_at: string | null;
  }>(
    'SELECT * FROM local_rounds WHERE id = ?',
    roundId
  );
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
  await database.runAsync('DELETE FROM local_scores WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_clips WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_rounds WHERE id = ?', roundId);
  await database.runAsync('DELETE FROM local_upload_queue WHERE round_id = ?', roundId);
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

export async function getQueuedRoundUploads() {
  const database = await getDatabase();
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
    "SELECT * FROM local_upload_queue WHERE status IN ('pending', 'error') ORDER BY created_at"
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
  }>(
    // `Library/Caches/ImagePicker/…` is the default expo-image-picker
    // output path — iOS purges that dir on memory pressure, so treat it
    // as legacy/evictable and migrate into documentDirectory.
    `SELECT id, round_id, file_uri, original_file_uri
     FROM local_clips
     WHERE file_uri LIKE 'ph://%'
        OR file_uri LIKE 'assets-library://%'
        OR file_uri LIKE '%/tmp/%'
        OR file_uri LIKE '%/Library/Caches/ImagePicker/%'
        OR original_file_uri LIKE 'ph://%'
        OR original_file_uri LIKE 'assets-library://%'
        OR original_file_uri LIKE '%/tmp/%'
        OR original_file_uri LIKE '%/Library/Caches/ImagePicker/%'`
  );
}

export async function updateClipFileUris(
  clipId: number,
  fileUri: string,
  originalFileUri?: string | null
) {
  const database = await getDatabase();
  if (originalFileUri !== undefined) {
    await database.runAsync(
      'UPDATE local_clips SET file_uri = ?, original_file_uri = ? WHERE id = ?',
      fileUri,
      originalFileUri,
      clipId
    );
  } else {
    await database.runAsync(
      'UPDATE local_clips SET file_uri = ? WHERE id = ?',
      fileUri,
      clipId
    );
  }
}

// (Generic key/value settings live earlier in this file against the
// local_settings table. Onboarding flags reuse those — no separate
// app_settings table needed.)

