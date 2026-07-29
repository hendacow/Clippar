import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReclaimableTempExport,
  tempExportFilenames,
  excludeFromBackup,
  TEMP_EXPORT_MAX_AGE_MS,
} from '../modules/shot-detector';

// MEDIA-003. Trim/stitch/tracer/reel temporaries are full-fidelity copies of
// the golfer's footage in Library/Caches. Nothing reclaimed them, so they were
// retained for the life of the install — including after the user deleted the
// round they came from. These tests pin the two properties that make an
// automatic sweep safe enough to run at startup: it deletes ONLY recognised
// temporary exports, and it never deletes one that is in use or still fresh.

const NOW = 1_800_000_000_000;
const OLD = NOW - TEMP_EXPORT_MAX_AGE_MS - 1;
const none: ReadonlySet<string> = new Set();

const opts = (over: Partial<Parameters<typeof isReclaimableTempExport>[1]> = {}) => ({
  modifiedAtMs: OLD,
  nowMs: NOW,
  maxAgeMs: TEMP_EXPORT_MAX_AGE_MS,
  inUseFilenames: none,
  ...over,
});

test('reclaims every family of aged-out temporary export', () => {
  for (const name of [
    'trim_ABC-123.mp4',
    'trim_ABC-123.mov',
    'stitch_DEF-456.mp4',
    'tracer_GHI-789.mp4',
    'clippar_reel_round-42.mp4',
  ]) {
    assert.equal(isReclaimableTempExport(name, opts()), true, `${name} should be reclaimable`);
  }
});

test('never touches files that are not temporary exports', () => {
  // The old clearTrimCache only matched trim_; widening it must NOT turn the
  // sweep into a general cache wipe — Library/Caches holds other subsystems'
  // data, e.g. the editor's recovered-clips/ downloads.
  for (const name of [
    'recovered-clips',
    'clippar.db',
    'ImagePicker',
    'trim_notavideo.txt',
    'my_trim_holiday.mp4', // prefix must anchor at the start
    'stitchy.mp4',
    'reel.mp4',
  ]) {
    assert.equal(isReclaimableTempExport(name, opts()), false, `${name} must be kept`);
  }
});

test('never deletes a temporary that is still referenced', () => {
  // The attack this prevents is data loss, not disclosure: a reel the player
  // is holding, or a trimmed clip recorded in local_clips, is old enough to
  // age out but must survive.
  const inUseFilenames = new Set(['stitch_LIVE.mp4', 'trim_INUSE.mov']);
  assert.equal(
    isReclaimableTempExport('stitch_LIVE.mp4', opts({ inUseFilenames })),
    false
  );
  assert.equal(
    isReclaimableTempExport('trim_INUSE.mov', opts({ inUseFilenames })),
    false
  );
  // ...while an unreferenced sibling in the same sweep still goes.
  assert.equal(
    isReclaimableTempExport('stitch_ORPHAN.mp4', opts({ inUseFilenames })),
    true
  );
});

test('never deletes a temporary younger than the retention window', () => {
  assert.equal(
    isReclaimableTempExport('stitch_FRESH.mp4', opts({ modifiedAtMs: NOW - 1000 })),
    false
  );
  // Exactly at the boundary is reclaimable; one ms short is not.
  assert.equal(
    isReclaimableTempExport('stitch_EDGE.mp4', {
      ...opts(),
      modifiedAtMs: NOW - TEMP_EXPORT_MAX_AGE_MS,
    }),
    true
  );
  assert.equal(
    isReclaimableTempExport('stitch_EDGE.mp4', {
      ...opts(),
      modifiedAtMs: NOW - TEMP_EXPORT_MAX_AGE_MS + 1,
    }),
    false
  );
});

test('an unreadable mtime is treated as fresh, never as ancient', () => {
  // A zero/absent modificationTime must fail closed. Reading it as epoch 0
  // would make every such file look a lifetime old and delete it.
  assert.equal(isReclaimableTempExport('trim_X.mp4', opts({ modifiedAtMs: 0 })), false);
});

test('in-use URIs are matched by filename through file://, escapes and query', () => {
  const names = tempExportFilenames([
    'file:///var/mobile/Containers/Data/Application/X/Library/Caches/stitch_A.mp4',
    '/var/mobile/.../Caches/trim_B.mov?v=2',
    'file:///Caches/clippar_reel_my%20round.mp4',
    null,
    undefined,
    '',
  ]);
  assert.deepEqual(
    [...names].sort(),
    ['clippar_reel_my round.mp4', 'stitch_A.mp4', 'trim_B.mov']
  );
});

test('excludeFromBackup reports failure honestly when native is missing', async () => {
  // MEDIA-002 must never look implemented when it is not: a caller that read a
  // bare `true` here would tell the user their clips are off iCloud when the
  // native counterpart does not exist in this binary.
  const result = await excludeFromBackup('file:///Documents/clips/');
  assert.equal(result.excluded, false);
  assert.equal(result.reason, 'native-unavailable');
});
