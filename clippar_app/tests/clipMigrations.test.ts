import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_TABLES_SQL, CLIP_TABLE_MIGRATIONS } from '../lib/clipMigrations';

// Real-SQLite migration test (S4/V4) via node:sqlite. Skipped gracefully on
// Node versions without it so CI never breaks on an older runtime — the app's
// migrateEditorColumns applies the same statements with the same swallow-on-dup
// semantics against expo-sqlite on device.
let DatabaseSync: (new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): any };
}) | undefined;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  /* older Node — skip below */
}
const opts = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

/** Apply the migration set the way the app does: per-statement, dup errors swallowed. */
function applyMigrations(db: { exec(sql: string): void }) {
  for (const sql of CLIP_TABLE_MIGRATIONS) {
    try {
      db.exec(sql + ';');
    } catch {
      // column/table already exists — idempotent, exactly like storage.ts
    }
  }
}

function columnNames(db: any, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name);
}

test('migrations are idempotent and keep pre-v2 rows readable', opts, () => {
  const db = new DatabaseSync!(':memory:');
  db.exec(BASE_TABLES_SQL);

  // A pre-v2 row: only the base columns exist at this point.
  db.prepare(
    `INSERT INTO local_clips (round_id, hole_number, shot_number, file_uri, gps_latitude, gps_longitude, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('round-1', 1, 1, 'file:///old.mp4', -37.8, 144.96, '2026-01-01T00:00:00Z');

  // Apply the full migration set TWICE — the second pass must not throw.
  applyMigrations(db);
  applyMigrations(db);

  // All Tracer V2 (+A8) columns now exist.
  const cols = columnNames(db, 'local_clips');
  for (const c of [
    'gps_eff_acc_m',
    'gps_fix_count',
    'gps_window_sec',
    'gps_source',
    'gps_fix_series',
    'gps_estimator_version',
    'recording_start_ts',
    'recording_stop_ts',
    'camera_roll_deg',
  ]) {
    assert.ok(cols.includes(c), `expected column ${c} after migration`);
  }

  // The pre-v2 row survived and reads back — its new columns are NULL.
  const oldRow = db
    .prepare('SELECT * FROM local_clips WHERE round_id = ?')
    .get('round-1');
  assert.equal(oldRow.file_uri, 'file:///old.mp4');
  assert.equal(oldRow.gps_latitude, -37.8);
  assert.equal(oldRow.gps_eff_acc_m, null);
  assert.equal(oldRow.gps_fix_series, null);
  assert.equal(oldRow.recording_start_ts, null);
  assert.equal(oldRow.camera_roll_deg, null);

  // A full v2 row round-trips through the new columns.
  db.prepare(
    `INSERT INTO local_clips (round_id, hole_number, shot_number, file_uri, timestamp,
       gps_eff_acc_m, gps_fix_count, gps_window_sec, gps_source, gps_fix_series,
       gps_estimator_version, recording_start_ts, recording_stop_ts, camera_roll_deg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'round-1', 2, 1, 'file:///new.mp4', '2026-07-02T00:00:00Z',
    3.6, 12, 24.0, 'impact', '[{"ts":1,"lat":-37.8,"lon":144.96,"acc":3,"speed":0,"course":0}]',
    1, 1719900000000, 1719900005000, -1.4
  );
  const newRow = db
    .prepare('SELECT * FROM local_clips WHERE file_uri = ?')
    .get('file:///new.mp4');
  assert.equal(newRow.gps_source, 'impact');
  assert.equal(newRow.gps_fix_count, 12);
  assert.equal(newRow.gps_estimator_version, 1);
  assert.equal(newRow.recording_start_ts, 1719900000000);
  assert.equal(newRow.camera_roll_deg, -1.4);
  assert.ok(String(newRow.gps_fix_series).includes('"lat":-37.8'));
});

test('base tables also created idempotently on a second open', opts, () => {
  const db = new DatabaseSync!(':memory:');
  db.exec(BASE_TABLES_SQL);
  db.exec(BASE_TABLES_SQL); // CREATE TABLE IF NOT EXISTS → no-op, no throw
  applyMigrations(db);
  for (const t of ['local_clips', 'local_rounds', 'local_scores', 'local_settings', 'local_upload_queue']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    assert.ok(row, `table ${t} should exist`);
  }
});
