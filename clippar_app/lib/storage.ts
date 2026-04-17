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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

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
  try {
    await db.execAsync(`
      ALTER TABLE local_clips ADD COLUMN trim_start_ms INTEGER DEFAULT 0;
    `);
  } catch {} // column already exists
  try {
    await db.execAsync(`
      ALTER TABLE local_clips ADD COLUMN trim_end_ms INTEGER DEFAULT -1;
    `);
  } catch {}
  try {
    await db.execAsync(`
      ALTER TABLE local_clips ADD COLUMN is_excluded INTEGER DEFAULT 0;
    `);
  } catch {}
  try {
    await db.execAsync(`
      ALTER TABLE local_clips ADD COLUMN sort_order INTEGER DEFAULT 0;
    `);
  } catch {}
}

export async function updateClipEditorState(
  clipId: number,
  updates: {
    trim_start_ms?: number;
    trim_end_ms?: number;
    is_excluded?: boolean;
    sort_order?: number;
  }
) {
  const database = await getDatabase();
  const fields: string[] = [];
  const values: (number)[] = [];

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
}) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO local_clips (round_id, hole_number, shot_number, file_uri, gps_latitude, gps_longitude, duration_seconds, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    clip.round_id,
    clip.hole_number,
    clip.shot_number,
    clip.file_uri,
    clip.gps_latitude ?? null,
    clip.gps_longitude ?? null,
    clip.duration_seconds ?? null,
    new Date().toISOString()
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

export async function deleteLocalRound(roundId: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM local_scores WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_clips WHERE round_id = ?', roundId);
  await database.runAsync('DELETE FROM local_rounds WHERE id = ?', roundId);
}

// Generic key/value settings (used by onboarding flags, etc.)
export async function getSetting(key: string): Promise<string | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ value: string | null }>(
    'SELECT value FROM app_settings WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const database = await getDatabase();
  if (value === null) {
    await database.runAsync('DELETE FROM app_settings WHERE key = ?', key);
    return;
  }
  await database.runAsync(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

