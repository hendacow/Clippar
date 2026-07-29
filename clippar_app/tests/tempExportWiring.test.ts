import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MEDIA-002 / MEDIA-003 wiring. The pure safety logic is pinned by
// tempExportReclaim.test.ts; these tests pin the part that logic cannot check
// about itself — that it is actually INVOKED, that the native counterpart it
// depends on exists, and that the "in use" set it is handed still covers every
// column the schema can point footage at. A reclaim sweep wired to a stale
// column list is worse than no sweep: it deletes the user's footage.
//
// app/_layout.tsx and lib/media.ts import react-native, which the node test
// runner cannot transform, so these assert on source text — the same approach
// privacyManifest.test.ts takes for the app config.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const layout = read('app/_layout.tsx');
const storage = read('lib/storage.ts');
const media = read('lib/media.ts');
const swift = read('modules/shot-detector/ios/ShotDetectorModule.swift');

test('the temp-export sweep has a real call site at startup', () => {
  // reclaimTemporaryExports shipped fully written and fully tested with zero
  // callers, which reads as protection while every trim/stitch/tracer copy of
  // the golfer's footage was still retained for the life of the install.
  assert.match(
    layout,
    /reclaimTemporaryExports\(\{/,
    'app/_layout.tsx must call reclaimTemporaryExports, not merely import it'
  );
  assert.match(layout, /from '@\/modules\/shot-detector'/);
});

test('the sweep runs only downstream of a successful in-use read', () => {
  // Fail-closed ordering: the SQLite read must happen BEFORE the sweep, so a
  // query that throws skips the sweep instead of being read as "nothing is in
  // use" — which would delete every trimmed clip and tracer render.
  const readAt = layout.indexOf('getAllAsync');
  const sweepAt = layout.indexOf('reclaimTemporaryExports({');
  assert.notEqual(readAt, -1, 'expected a local_clips read in _layout.tsx');
  assert.notEqual(sweepAt, -1);
  assert.ok(readAt < sweepAt, 'in-use URIs must be read before the sweep runs');
});

test('every URI column on local_clips is treated as in use', () => {
  // Schema drift is the realistic way this turns destructive: someone adds a
  // fifth *_uri column, the sweep keeps its four, and files that column points
  // at start ageing out into deletion.
  const created = storage.slice(
    storage.indexOf('CREATE TABLE IF NOT EXISTS local_clips'),
    storage.indexOf('CREATE TABLE IF NOT EXISTS local_rounds')
  );
  const uriColumns = new Set<string>();
  for (const m of created.matchAll(/^\s*(\w+_uri)\s+TEXT/gm)) uriColumns.add(m[1]);
  for (const m of storage.matchAll(
    /ALTER TABLE local_clips ADD COLUMN (\w+_uri)\b/g
  )) {
    uriColumns.add(m[1]);
  }

  assert.ok(uriColumns.size >= 4, `expected local_clips URI columns, got ${[...uriColumns]}`);

  // Check the SELECT list and the row→URI projection separately: a column
  // named only in the TypeScript row type is still not read, and a column
  // selected but not projected is still not protected.
  const select = layout.match(/'SELECT ([^']+) FROM local_clips'/);
  assert.ok(select, 'expected a local_clips SELECT literal in app/_layout.tsx');
  const projectionAt = layout.indexOf('inUseUris:');
  assert.notEqual(projectionAt, -1, 'expected an inUseUris argument in app/_layout.tsx');
  const projection = layout.slice(projectionAt, projectionAt + 400);

  for (const column of uriColumns) {
    assert.ok(
      select[1].includes(column),
      `local_clips.${column} can hold a cached export path but is not SELECTed into the in-use set in app/_layout.tsx`
    );
    assert.ok(
      projection.includes(`r.${column}`),
      `local_clips.${column} is selected but never passed to reclaimTemporaryExports as in use`
    );
  }
});

test('backup exclusion has a native implementation, not just a JS wrapper', () => {
  // The JS wrapper reports { excluded: false, reason: 'native-unavailable' }
  // when this function is absent. Shipping that state permanently would leave
  // the storage-settings "clips not in the cloud" copy false.
  assert.match(
    swift,
    /AsyncFunction\("excludeFromBackup"\)/,
    'ShotDetectorModule must register excludeFromBackup'
  );
  assert.match(
    swift,
    /isExcludedFromBackup = true/,
    'excludeFromBackup must set NSURLIsExcludedFromBackupKey'
  );
  assert.match(
    swift,
    /FileProtectionType\.completeUnlessOpen/,
    'clips/ must also get a Data Protection class above the platform default'
  );
  assert.match(
    swift,
    /\.protectionKey: protection/,
    'the protection class must actually be applied via setAttributes'
  );
});

test('clips/ creation is the call site for backup exclusion', () => {
  // Directory-level, once, at creation — so every clip written afterwards
  // inherits it and no future write site has to remember.
  assert.match(media, /markClipsDirExcludedFromBackup\(dir\)/);
  assert.match(media, /excludeFromBackup\(dir\)/);
});
