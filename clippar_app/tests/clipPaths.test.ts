import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isEvictableUri,
  isPurgeableAppPath,
  evictableUriSql,
  videoExtension,
} from '../lib/clipPaths';

// A recorded clip was never moved off the directory expo-camera writes it to.
// `FileSystemUtilities.generatePathInCache(appContext, in: "Camera", …)` puts
// the .mov in Library/Caches, hooks/useCamera.ts stored that path into
// local_clips as both file_uri and original_file_uri, and iOS is free to
// reclaim that directory whenever the phone is short of space. Imports have
// been persisted into documentDirectory/clips/ since the picker-cache fix;
// recordings — the way most footage enters the app, and the half with no
// Photos copy behind it unless mirroring is on — were not. A round is played
// once. Footage the OS deletes is not recoverable.
//
// The reason it stayed broken through a fix aimed at exactly this hazard is
// that the rule was written out four times: the SQL that chooses rows, the two
// closures in uriMigration that act on them, and persistAsset's move-vs-copy
// check. Adding the camera directory to any one of them alone changes nothing —
// extend only the predicate and the query still won't return those rows. So
// these tests come in two halves:
//
//   1. the rule, executed (lib/clipPaths is pure);
//   2. the wiring, asserted on source text — that all four sites take their
//      answer from it, and that the record path persists before it inserts.
//
// WHAT THESE CANNOT PROVE. Nothing in Node can run AVFoundation, expo-camera
// or SQLite, so no test here shows a real recording landing in
// documentDirectory/clips/. That needs a device: record a hole, then check
// `SELECT file_uri, original_file_uri FROM local_clips ORDER BY id DESC LIMIT 1`
// contains /Documents/clips/ and not /Library/Caches/ — it used to be the
// cache path for every recorded clip ever made. For the migration half,
// install a build from before this change, record a round, upgrade, and
// confirm the same query flips on next launch.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const useCamera = read('hooks/useCamera.ts');
const migration = read('lib/uriMigration.ts');
const media = read('lib/media.ts');
const storage = read('lib/storage.ts');

// Real shapes, as they appear in local_clips.
const CONTAINER = 'file:///var/mobile/Containers/Data/Application/1F2E-4A/';
const RECORDED = `${CONTAINER}Library/Caches/Camera/9C4B-11EE-8F.mov`;
// Under a scoped (Expo Go) config the cache directory gains a segment, so
// neither `/Library/Caches/Camera/` nor a bare `/Camera/` matches both builds.
const RECORDED_SCOPED = `${CONTAINER}Library/Caches/ExponentExperienceData/@anonymous/clippar/Camera/9C4B.mov`;
const PICKED = `${CONTAINER}Library/Caches/ImagePicker/40B1-9C.mp4`;
const TMP = `${CONTAINER}tmp/ReactNative/7A2C.mp4`;
const DURABLE = `${CONTAINER}Documents/clips/recorded_r1_h4_s2_1754300000000.mov`;
// modules/shot-detector writes its derivatives to the cache ROOT.
const TRIMMED = `${CONTAINER}Library/Caches/trim_3D9F-88.mov`;
const REEL = `${CONTAINER}Library/Caches/reel_5E7A-21.mp4`;

// ── 1. the rule ─────────────────────────────────────────────────────────

test('a recorded clip in the camera cache is evictable, in both build shapes', () => {
  for (const uri of [RECORDED, RECORDED_SCOPED]) {
    assert.equal(isEvictableUri(uri), true, uri);
    // Purgeable too, not merely evictable: the rescue has to MOVE the file.
    // Resolving does nothing — it is already a valid path to a doomed file.
    assert.equal(isPurgeableAppPath(uri), true, uri);
  }
});

test('the import-era paths still match — this fix must not narrow them', () => {
  for (const uri of [PICKED, TMP]) {
    assert.equal(isEvictableUri(uri), true, uri);
    assert.equal(isPurgeableAppPath(uri), true, uri);
  }
});

test('photo references are evictable but must be resolved, never moved', () => {
  for (const uri of ['ph://9C4B-11EE/L0/001', 'assets-library://asset/asset.MOV']) {
    assert.equal(isEvictableUri(uri), true, uri);
    assert.equal(isPurgeableAppPath(uri), false, uri);
  }
});

test('a clip already in documentDirectory is left alone', () => {
  assert.equal(isEvictableUri(DURABLE), false);
  assert.equal(isPurgeableAppPath(DURABLE), false);
});

test('a trimmed clip in the cache root is evictable too', () => {
  // markClipTrimmed promotes modules/shot-detector's trim_<uuid> output into
  // file_uri, so the file the editor PLAYS was as evictable as the recording
  // — and worse off, because auto_trimmed=1/needs_trim=0 means nothing ever
  // regenerates it.
  assert.equal(isEvictableUri(TRIMMED), true);
  assert.equal(isPurgeableAppPath(TRIMMED), true);
});

test('rescuing cached trims cannot contend with the temp-export sweep', () => {
  // reclaimTemporaryExports ages trim_/stitch_/tracer_/clippar_reel_ files out
  // of the cache, but SKIPS anything a local_clips row still points at — and a
  // row pointing at it is the only reason the migration would touch a file. So
  // the sweeper only ever deletes what this never sees. The composed reel is
  // safe for a different reason: it is local_rounds.reel_url, a column this
  // rule is never applied to. Both are asserted here as source facts, since
  // Node cannot run either system.
  const reclaim = read('lib/cacheReclaim.ts');
  const layout = read('app/_layout.tsx');
  assert.match(layout, /inUseUris: rows\.flatMap/);
  assert.match(reclaim, /in-use set/i);
  // The migration reads local_clips only — never the rounds table that owns
  // reel_url, so REEL is out of its reach whatever the predicate says.
  assert.ok(!/local_rounds/.test(migration), 'the migration must not reach into local_rounds');
  assert.equal(isEvictableUri(REEL), true, 'a reel path would match — it is simply never fed in');
});

test('empty and missing uris are not evictable', () => {
  assert.equal(isEvictableUri(''), false);
  assert.equal(isEvictableUri(null), false);
  assert.equal(isPurgeableAppPath(undefined), false);
});

test('the generated SQL covers every case the predicate does', () => {
  const sql = evictableUriSql('file_uri');
  assert.match(sql, /file_uri LIKE 'ph:\/\/%'/);
  assert.match(sql, /file_uri LIKE 'assets-library:\/\/%'/);
  assert.match(sql, /file_uri LIKE '%\/tmp\/%'/);
  // One clause for the whole cache directory, covering ImagePicker/, Camera/
  // and the trim_ output at its root — an enumeration of known subpaths is
  // what left the camera and trim directories out to begin with.
  assert.match(sql, /file_uri LIKE '%\/Library\/Caches\/%'/);

  // Whatever the predicate accepts, the query must select. Cheap to assert
  // directly, since both come from the same list.
  for (const uri of [RECORDED, RECORDED_SCOPED, PICKED, TMP, TRIMMED]) {
    assert.equal(isEvictableUri(uri), true, uri);
    const fragment = uri.includes('/tmp/') ? '/tmp/' : '/Library/Caches/';
    assert.ok(sql.includes(`'%${fragment}%'`), `${uri} has no matching LIKE`);
  }
});

test('evictableUriSql refuses anything that is not a plain column name', () => {
  assert.throws(() => evictableUriSql("file_uri' OR 1=1 --"), /unsafe column/);
  assert.doesNotThrow(() => evictableUriSql('original_file_uri'));
});

test('videoExtension keeps a recording a .mov', () => {
  assert.equal(videoExtension(RECORDED), 'mov');
  assert.equal(videoExtension(PICKED), 'mp4');
  // The rescue paths used to hardcode .mp4 for both. AVURLAsset takes the
  // extension as a type hint, so a mislabelled QuickTime file is the kind of
  // thing that previews fine and then fails at export.
  assert.equal(videoExtension(`${CONTAINER}tmp/no-extension`, 'mov'), 'mov');
  assert.equal(videoExtension(`${CONTAINER}tmp/weird.verylongext`), 'mp4');
});

// ── 2. the wiring ───────────────────────────────────────────────────────

test('the record path persists the clip BEFORE the row is written', () => {
  const persist = useCamera.indexOf('persistAsset(');
  const insert = useCamera.indexOf('await saveLocalClip({');
  assert.ok(persist > 0, 'hooks/useCamera.ts must call persistAsset');
  assert.ok(insert > 0, 'hooks/useCamera.ts must still insert the clip row');
  assert.ok(
    persist < insert,
    'persistAsset must be started before saveLocalClip — the row must never be written with a path we are about to move'
  );
  // And the row must take the persisted result, not the raw recording path.
  const awaited = useCamera.indexOf('const finalUri = await durableUriPromise;');
  assert.ok(awaited > 0 && awaited < insert, 'finalUri must be the persisted uri');
  assert.ok(
    !/const finalUri = video\.uri/.test(useCamera),
    'finalUri must no longer be the raw Library/Caches/Camera path'
  );
});

test('every site that classifies a clip path asks lib/clipPaths', () => {
  assert.match(migration, /from '@\/lib\/clipPaths'/);
  assert.match(media, /from '@\/lib\/clipPaths'/);
  assert.match(storage, /from '\.\/clipPaths'/);

  // persistAsset's move-vs-copy decision is the same question, so a recording
  // gets the O(1) rename instead of a ~150MB byte copy on the record path.
  assert.match(media, /const inAppCache = isPurgeableAppPath\(resolved\)/);

  // The query that feeds the migration is generated from the same list. This
  // is the assertion that would have failed before the fix: extending the
  // predicates while leaving a hand-written WHERE behind makes the new branch
  // unreachable and rescues nothing.
  assert.match(storage, /WHERE \$\{evictableUriSql\('file_uri'\)\}/);
  assert.match(storage, /OR \$\{evictableUriSql\('original_file_uri'\)\}/);
});

test('no call site re-implements the rule locally', () => {
  for (const [name, src] of [
    ['lib/uriMigration.ts', migration],
    ['lib/media.ts', media],
    ['lib/storage.ts', storage],
  ] as const) {
    // Comments explain the shapes; code must not re-test them by hand.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    assert.ok(
      !/includes\('\/Library\/Caches\//.test(code),
      `${name} must not hand-roll a cache-path check — use lib/clipPaths`
    );
    assert.ok(
      !/LIKE '%\/Library\/Caches\//.test(code),
      `${name} must not hand-roll a cache-path LIKE — use evictableUriSql`
    );
  }
});

test('the trim is persisted before the row is pointed at it', () => {
  const persist = storage.indexOf('const durableUri = await persistTrimOutput(');
  const update = storage.indexOf('file_uri = ?,\n      trimmed_file_uri = ?');
  assert.ok(persist > 0, 'markClipTrimmed must persist its trim output');
  assert.ok(update > persist, 'the UPDATE must come after the persist');
  // And it must write the persisted path, not the cache path it was handed.
  assert.ok(
    !/\n    trimmedFileUri,\n    trimmedFileUri,/.test(storage),
    'markClipTrimmed must bind durableUri, not the raw trimmedFileUri'
  );
  // An already-durable original (putt / no-detection) must not be copied.
  assert.match(storage, /if \(!isPurgeableAppPath\(uri\)\) return uri;/);
});

test('a superseded trim is unlinked, and the original never is', () => {
  // Persisting trims into documentDirectory takes them out of reach of
  // reclaimTemporaryExports, which used to collect the ones a re-trim
  // orphaned. Without this, each re-trim strands a full-fidelity copy.
  assert.match(storage, /const superseded = before\?\.trimmed_file_uri;/);
  assert.match(storage, /superseded !== durableUri/);
  assert.match(storage, /superseded !== before\?\.original_file_uri/);
  assert.match(storage, /shotDetector\.deleteFile\(superseded\)/);
});

test('the trim is COPIED, so a mounted editor keeps a valid path', () => {
  // hooks/useEditorState.ts assigns result.trimmedUri to updatedClip.sourceUri
  // and pushes it into React state BEFORE markClipTrimmed runs. Renaming that
  // file away would leave the open editor pointing at nothing — preview and
  // export fail until the screen is rebuilt from SQLite. The record path is
  // the opposite case and must keep its move: nothing reads video.uri after
  // it, and it is ~150MB.
  assert.match(storage, /\{ keepSource: true \}/);
  assert.match(media, /keepSource\?: boolean;/);
  assert.match(media, /isPurgeableAppPath\(resolved\) && !opts\?\.keepSource/);
  assert.ok(
    !/keepSource/.test(useCamera),
    'the record path must still MOVE — a copy there costs a beat between shots'
  );

  // The editor really does stage the cache path in React state before the
  // write; if that ever stops being true this test should be revisited rather
  // than silently passing.
  const editor = read('hooks/useEditorState.ts');
  assert.match(editor, /updatedClip\.sourceUri = result\.trimmedUri;/);
});

test('persistAsset refuses a filename that could escape clips/', () => {
  // The filename is concatenated onto documentDirectory/clips/ and handed to
  // moveAsync/copyAsync. No caller can reach it with a separator today (uuids
  // and row ids), but this PR took persistAsset from one caller to three, so
  // the guard belongs at the sink. Mirrors evictableUriSql's identifier check.
  assert.match(media, /persistAsset: unsafe filename/);
  assert.match(media, /\/\[\/\\\\\]\/\.test\(filename\)/);
  // Ahead of the try, or it would be swallowed into "returned the source uri".
  const guard = media.indexOf('unsafe filename');
  const tryBlock = media.indexOf('const t0 = Date.now();');
  assert.ok(guard < tryBlock, 'the filename guard must precede the try block');
});

test('a row deleted DURING the copy does not strand the durable file', () => {
  // The precheck cannot see a delete that lands while the copy is in flight.
  // The UPDATE's own row count can.
  assert.match(storage, /const written = await database\.runAsync\(/);
  assert.match(storage, /if \(written\.changes === 0\)/);
  assert.match(storage, /shotDetector\.deleteFile\(durableUri\)/);
  // Never delete a path we did not create — an unpersisted uri is the
  // caller's file, not ours.
  assert.match(storage, /if \(durableUri !== trimmedFileUri\)/);
});

test('a clip deleted mid-detection is not left a stranded trim', () => {
  // "Delete last shot" during detection: moving the trim into clips/ for a row
  // that no longer exists would leave it there forever. Left in the cache, the
  // temp-export sweep collects it.
  assert.match(storage, /if \(!before\) return;/);
  const guard = storage.indexOf('if (!before) return;');
  const persist = storage.indexOf('const durableUri = await persistTrimOutput(');
  assert.ok(guard < persist, 'the row check must precede the move');
});

test('the migration keeps trimmed_file_uri in step with file_uri', () => {
  // The column is a duplicate of file_uri, so rescuing file_uri alone leaves
  // it naming a cache file the migration just moved away.
  assert.match(storage, /SELECT id, round_id, file_uri, original_file_uri, trimmed_file_uri/);
  assert.match(migration, /await rescue\(row\.trimmed_file_uri, 'trimmed'\)/);
  assert.match(migration, /nextTrimmedUri !== row\.trimmed_file_uri/);
  assert.match(
    migration,
    /updateClipFileUris\(row\.id, nextFileUri, nextOriginalUri, nextTrimmedUri\)/
  );
});

test('the migration moves a shared source path only once', () => {
  // file_uri and original_file_uri hold the SAME path for every untrimmed
  // clip, and the rescue is a move. Rescuing the columns independently
  // relocates the file for the first and leaves the second pointing into the
  // directory we just emptied.
  assert.match(migration, /const rescued = new Map<string, string>\(\)/);
  assert.match(migration, /rescued\.get\(uri\)/);
  assert.match(migration, /await rescue\(row\.file_uri, 'clip'\)/);
  assert.match(migration, /await rescue\(row\.original_file_uri, 'orig'\)/);
});
