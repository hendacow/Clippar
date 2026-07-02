/**
 * clipMigrations.ts — the SQLite schema for the local clip/round/score tables,
 * as plain SQL strings with ZERO native (expo-sqlite) imports.
 *
 * Extracted from storage.ts so the migration set can be exercised in CI against
 * a real SQLite engine (node:sqlite) — proving idempotency and that pre-v2 rows
 * stay readable after the Tracer V2 columns are added (S4/V4). storage.ts is the
 * only runtime consumer; the app behaviour is unchanged by the extraction.
 *
 * Invariants the migration mechanism relies on:
 *   • Every statement is `ADD COLUMN` or `CREATE TABLE IF NOT EXISTS`, applied
 *     inside a per-statement try/catch, so re-running the whole set is a no-op
 *     (a duplicate-column error is swallowed).
 *   • Every added column is nullable / has a default, so old rows read back.
 */

/** Base tables (fresh install). Mirrors the CREATE set in storage.initTables. */
export const BASE_TABLES_SQL = `
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
`;

/** Additive migrations applied (idempotently) on every open. */
export const CLIP_TABLE_MIGRATIONS: string[] = [
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
  // A8 (camera-angle robustness): device roll at capture, alongside pitch.
  // Native getDeviceAttitude() → {pitchDownDeg, rollDeg} feeds this; NULL on
  // older clips / builds where only getDevicePitchDeg() is available.
  'ALTER TABLE local_clips ADD COLUMN camera_roll_deg REAL',
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
  // Tracer V2 GPS backbone (S4). The estimator's per-shot output + the raw
  // fix series (JSON, ≤60 fixes) so the fix is re-derivable at impact time
  // without re-recording (A1); estimator_version gates re-processing. The v1
  // gps_latitude/gps_longitude/gps_accuracy_m columns above STAY populated
  // (gps_accuracy_m carries effAcc on the v2 path). recording_start_ts /
  // recording_stop_ts are absolute ms so the definitive anchor
  // (start + impact_time_ms) can be reconstructed. All nullable → pre-v2 rows
  // read back fine; ALTERs are idempotent (dup-column error swallowed).
  'ALTER TABLE local_clips ADD COLUMN gps_eff_acc_m REAL',
  'ALTER TABLE local_clips ADD COLUMN gps_fix_count INTEGER',
  'ALTER TABLE local_clips ADD COLUMN gps_window_sec REAL',
  'ALTER TABLE local_clips ADD COLUMN gps_source TEXT',
  'ALTER TABLE local_clips ADD COLUMN gps_fix_series TEXT',
  'ALTER TABLE local_clips ADD COLUMN gps_estimator_version INTEGER',
  'ALTER TABLE local_clips ADD COLUMN recording_start_ts INTEGER',
  'ALTER TABLE local_clips ADD COLUMN recording_stop_ts INTEGER',
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
