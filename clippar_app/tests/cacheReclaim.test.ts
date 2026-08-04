import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  formatBytes,
  bytesFreedFrom,
  isStaleEnoughToReclaim,
} from '../lib/cacheReclaim';

// Profile → "Clear Cache" used to be a success buzz over a no-op: it promised
// "Cached thumbnails and temp files will be removed" and freed zero bytes.
//
// SCOPE OF THIS FILE. The node runner transforms no React and mounts no
// filesystem, so nothing here executes a delete. What it CAN pin is the pure
// arithmetic the honest version reports with (the byte formatting and the
// before/after diff), the fail-closed age rule, and — by reading source text,
// the approach tempExportWiring.test.ts and privacyManifest.test.ts already
// take — that the reclaim is actually wired up and still covers every column
// the schema can point footage at. Whether deleteAsync removes the right inode
// is only provable on a device.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

// ─── formatBytes: the number the user is told, and can go and check ───

test('formatBytes reports a size a golfer can compare with iPhone Storage', () => {
  // Decimal units, matching Settings → General → iPhone Storage.
  assert.equal(formatBytes(24_300_000), '24.3 MB');
  assert.equal(formatBytes(1_000_000), '1.0 MB');
  assert.equal(formatBytes(2_400_000_000), '2.4 GB');
  assert.equal(formatBytes(912_000), '912 KB');
  assert.equal(formatBytes(1_500), '2 KB');
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(512), '512 bytes');
});

test('formatBytes never invents space that was not freed', () => {
  // The whole point of showing a number is that it is true. A NaN or negative
  // must not render as "NaN MB" or a negative saving — the caller treats zero
  // as "nothing to clear" and says so plainly instead.
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(-1), '0 bytes');
  assert.equal(formatBytes(NaN), '0 bytes');
  assert.equal(formatBytes(Infinity), '0 bytes');
});

// ─── bytesFreedFrom: only count what actually went ───

test('only files that are gone after the sweep count as freed', () => {
  // reclaimTemporaryExports reports HOW MANY files it deleted but not WHICH,
  // and it deliberately keeps ones that are in use or too recent. Counting
  // those would overstate the saving to the user.
  const before = new Map([
    ['trim_GONE.mp4', 1_000_000],
    ['stitch_INUSE.mp4', 5_000_000],
    ['tracer_TOORECENT.mp4', 2_000_000],
  ]);
  const remaining = new Set(['stitch_INUSE.mp4', 'tracer_TOORECENT.mp4', 'reel_KEEP.mp4']);
  assert.equal(bytesFreedFrom(before, remaining), 1_000_000);
});

test('a sweep that deleted nothing reports zero, not a guess', () => {
  const before = new Map([['trim_A.mp4', 9_999]]);
  assert.equal(bytesFreedFrom(before, new Set(['trim_A.mp4'])), 0);
  assert.equal(bytesFreedFrom(new Map(), new Set(['trim_A.mp4'])), 0);
});

// ─── isStaleEnoughToReclaim: the guard that stops us racing an export ───

test('an unreadable modification time is treated as brand new, never ancient', () => {
  // Fail closed. Reading a missing mtime as epoch 0 would make every such file
  // look a lifetime old, and these files are full-fidelity copies of footage
  // that cannot be re-recorded.
  const nowMs = 1_800_000_000_000;
  assert.equal(isStaleEnoughToReclaim({ modifiedAtMs: 0, nowMs, maxAgeMs: 1000 }), false);
});

test('files younger than the grace window survive an explicit Clear Cache', () => {
  // The user asking for space does not make a compose that is still running
  // safe to interrupt.
  const nowMs = 1_800_000_000_000;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  assert.equal(
    isStaleEnoughToReclaim({ modifiedAtMs: nowMs - 60_000, nowMs, maxAgeMs }),
    false
  );
  assert.equal(
    isStaleEnoughToReclaim({ modifiedAtMs: nowMs - maxAgeMs, nowMs, maxAgeMs }),
    true
  );
  assert.equal(
    isStaleEnoughToReclaim({ modifiedAtMs: nowMs - maxAgeMs + 1, nowMs, maxAgeMs }),
    false
  );
});

// ─── Wiring: the parts the pure logic cannot check about itself ───

test('Clear Cache calls the reclaim instead of buzzing success', () => {
  const profile = read('app/(tabs)/profile.tsx');
  assert.match(
    profile,
    /clearDisposableCaches\(\)/,
    'the Clear Cache row must actually run the sweep, not merely import it'
  );
  assert.match(
    profile,
    /formatBytes\(bytesFreed\)/,
    'the user must be told the bytes actually freed — that is what makes the claim checkable'
  );
});

test('the success haptic never fires on a no-op or a failure', () => {
  // This is the original bug, restated as a test: a Success notification that
  // is not guarded by "we actually freed something" is a lie to the user.
  const profile = read('app/(tabs)/profile.tsx');
  const start = profile.indexOf('const runClearCache');
  assert.notEqual(start, -1, 'expected a runClearCache handler in profile.tsx');
  const handler = profile.slice(start, profile.indexOf('const handleClearCache'));
  const successAt = handler.indexOf('NotificationFeedbackType.Success');
  const guardAt = handler.indexOf('bytesFreed > 0');
  assert.notEqual(successAt, -1, 'expected a success haptic on the freed-something path');
  assert.notEqual(guardAt, -1, 'expected a bytesFreed > 0 guard');
  assert.ok(guardAt < successAt, 'the success haptic must sit inside the bytesFreed > 0 branch');
  // ...and the two unhappy paths must be distinguishable rather than collapsed
  // into one cheerful message.
  assert.match(handler, /hadErrors/);
  assert.match(handler, /Nothing to clear/);
});

test('every URI column on local_clips is treated as in use by the sweep', () => {
  // Schema drift is the realistic way this turns destructive: someone adds a
  // fifth *_uri column, Clear Cache keeps its four, and the files that column
  // points at start ageing out into deletion. Same check tempExportWiring.
  // test.ts runs against the startup sweep — this is the second call site.
  const storage = read('lib/storage.ts');
  const reclaim = read('lib/cacheReclaim.ts');

  const created = storage.slice(
    storage.indexOf('CREATE TABLE IF NOT EXISTS local_clips'),
    storage.indexOf('CREATE TABLE IF NOT EXISTS local_rounds')
  );
  const uriColumns = new Set<string>();
  for (const m of created.matchAll(/^\s*(\w+_uri)\s+TEXT/gm)) uriColumns.add(m[1]);
  for (const m of storage.matchAll(/ALTER TABLE local_clips ADD COLUMN (\w+_uri)\b/g)) {
    uriColumns.add(m[1]);
  }
  assert.ok(uriColumns.size >= 4, `expected local_clips URI columns, got ${[...uriColumns]}`);

  const select = reclaim.match(/'SELECT ([^']+) FROM local_clips'/);
  assert.ok(select, 'expected a local_clips SELECT literal in lib/cacheReclaim.ts');
  const projectionAt = reclaim.indexOf('return rows.flatMap');
  assert.notEqual(projectionAt, -1, 'expected the row→URI projection in lib/cacheReclaim.ts');
  const projection = reclaim.slice(projectionAt, projectionAt + 400);

  for (const column of uriColumns) {
    assert.ok(
      select[1].includes(column),
      `local_clips.${column} can hold a cached export path but is not SELECTed into Clear Cache's in-use set`
    );
    assert.ok(
      projection.includes(`r.${column}`),
      `local_clips.${column} is selected but never passed to reclaimTemporaryExports as in use`
    );
  }
});

test('the in-use read happens before anything is deleted', () => {
  // Fail-closed ordering. A query that throws must skip the whole sweep rather
  // than be read as "nothing on this device is in use".
  const reclaim = read('lib/cacheReclaim.ts');
  const body = reclaim.slice(reclaim.indexOf('export async function clearDisposableCaches'));
  const readAt = body.indexOf('await readInUseClipUris()');
  const firstStepAt = body.indexOf('await step(');
  assert.notEqual(readAt, -1, 'expected clearDisposableCaches to read the in-use set');
  assert.notEqual(firstStepAt, -1);
  assert.ok(readAt < firstStepAt, 'the in-use read must precede every sweep step');
  // And it must not quietly swallow the failure into an empty set, which is
  // what makes reclaimTemporaryExports destructive.
  assert.doesNotMatch(body, /inUseUris:\s*\[\]/);
});

test('Clear Cache never sweeps composed reels or the source clip directories', () => {
  // cacheDirectory holds reel_<uuid>.mp4, which app/round/editor.tsx writes
  // straight into rounds.reel_url — upload is opt-in, so for a user who never
  // asked for a share link that file IS the reel. A blanket cache wipe here
  // would shred it, along with documentDirectory/clips/.
  const reclaim = read('lib/cacheReclaim.ts');
  const code = reclaim.slice(reclaim.indexOf('// ─── Filesystem sweep ───'));
  assert.doesNotMatch(code, /deleteAsync\(\s*cacheDir/, 'must never delete the cache root');
  assert.doesNotMatch(code, /documentDirectory/, 'must never reach into documentDirectory');
  assert.doesNotMatch(code, /'reel_'|"reel_"/, 'reel_ must never become a swept prefix');
  for (const prefix of ['trim_', 'stitch_', 'tracer_', 'clippar_reel_']) {
    assert.ok(code.includes(prefix), `expected ${prefix} among the measured temp exports`);
  }
});

test('Verify My Rounds is dev-only, and takes its Divider with it', () => {
  // It reports raw round UUIDs and internal issue strings, names the backend
  // in user-facing copy, and measures cloud reachability on an app whose cloud
  // backup is off by default — so on a free account it flags every round as
  // broken. Gated like Diagnostics. The Divider has to live inside the gate or
  // the Support card ends on a stray rule in production.
  const profile = read('app/(tabs)/profile.tsx');
  const rowAt = profile.indexOf('Verify My Rounds');
  assert.notEqual(rowAt, -1);
  const gateAt = profile.lastIndexOf('{__DEV__ && (', rowAt);
  assert.notEqual(gateAt, -1, 'the Verify My Rounds row must sit behind a __DEV__ gate');
  const gated = profile.slice(gateAt, rowAt);
  // The nearest gate must be the row's OWN gate — an intervening `</>` means
  // we found an earlier one (Diagnostics) and the row is outside it.
  assert.doesNotMatch(
    gated,
    /<\/>/,
    'the nearest __DEV__ gate closes before the row — the row is not actually gated'
  );
  assert.match(gated, /<Divider \/>/, 'the Divider above the row must be inside the gate');
  // Nothing may follow it inside the Support card except the card closing.
  const afterRow = profile.slice(rowAt, profile.indexOf('LEGAL', rowAt));
  assert.doesNotMatch(
    afterRow.slice(afterRow.indexOf('</>')),
    /<Divider \/>/,
    'no trailing Divider may survive the gate'
  );
});
