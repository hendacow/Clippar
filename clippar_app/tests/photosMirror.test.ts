import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import {
  resolveMirrorPlan,
  resolvePersistedAssetId,
  describeRawClipStatus,
} from '../lib/photosMirrorPolicy';

// "Save raw clips to Photos" shipped with ONE reader — app/round/import.tsx.
// The record path never read it, so every clip the app itself captured was
// written with no photos_asset_id and was invisible to reinstall recovery,
// while Storage & Backup showed a green tick claiming the opposite. The bug
// was not a missing function; it was two capture paths disagreeing about a
// setting that was labelled for both. So these tests are in two halves:
//
//   1. the shared decision, executed (lib/photosMirrorPolicy is pure);
//   2. the wiring, asserted on source text — that BOTH paths route through
//      the one helper, in the right order, onto the same column.
//
// WHAT THESE CANNOT PROVE. Nothing in Node can call MediaLibrary, expo-camera
// or SQLite, so no test here shows that a real recording lands in a real
// camera roll. That needs a device: enable "Save raw clips to Photos", grant
// Photos access, record a round, then confirm (a) the raw clips appear in the
// camera roll and (b) `SELECT id, photos_asset_id FROM local_clips WHERE
// round_id = ?` is non-NULL for every recorded clip — it used to be NULL for
// all of them. Deleting the app and reinstalling should then re-import them.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const useCamera = read('hooks/useCamera.ts');
const importScreen = read('app/round/import.tsx');
const settings = read('app/profile/storage-settings.tsx');
const storage = read('lib/storage.ts');
const mirror = read('lib/photosMirror.ts');
const recovery = read('lib/photosRecovery.ts');

// ── 1. the shared decision ──────────────────────────────────────────────

const device = { native: true, mediaLibraryAvailable: true } as const;

test('a clip is mirrored only when the user asked for it', () => {
  assert.deepEqual(
    resolveMirrorPlan({ ...device, mirrorEnabled: true, fileUri: 'file:///a.mp4' }),
    { action: 'mirror' }
  );
  assert.deepEqual(
    resolveMirrorPlan({ ...device, mirrorEnabled: false, fileUri: 'file:///a.mp4' }),
    { action: 'skip', reason: 'setting-off' }
  );
});

test('a clip already in Photos keeps its id and is never copied twice', () => {
  // Free recovery: the picker hands us the id of a video that is already in
  // the library. Kept even with the setting OFF — the setting governs whether
  // we WRITE copies, not whether we throw away a restore path we already have.
  for (const mirrorEnabled of [true, false]) {
    assert.deepEqual(
      resolveMirrorPlan({
        ...device,
        mirrorEnabled,
        fileUri: 'file:///a.mp4',
        existingAssetId: 'ph-123',
      }),
      { action: 'reuse', assetId: 'ph-123' }
    );
  }
});

test('a blank asset id is not treated as a Photos copy', () => {
  // '' is what the recovery query already refuses to match
  // (photos_asset_id != ''), so the plan must not treat it as an existing
  // asset either, or the clip is skipped here AND skipped on restore.
  const plan = resolveMirrorPlan({
    ...device,
    mirrorEnabled: true,
    fileUri: 'file:///a.mp4',
    existingAssetId: '   ',
  });
  assert.deepEqual(plan, { action: 'mirror' });
});

test('nothing is attempted where Photos does not exist', () => {
  assert.deepEqual(
    resolveMirrorPlan({
      mirrorEnabled: true,
      fileUri: 'file:///a.mp4',
      native: false,
      mediaLibraryAvailable: false,
    }),
    { action: 'skip', reason: 'unsupported-platform' }
  );
  assert.deepEqual(
    resolveMirrorPlan({
      mirrorEnabled: true,
      fileUri: 'file:///a.mp4',
      native: true,
      mediaLibraryAvailable: false,
    }),
    { action: 'skip', reason: 'unsupported-platform' }
  );
  assert.deepEqual(
    resolveMirrorPlan({ ...device, mirrorEnabled: true, fileUri: '' }),
    { action: 'skip', reason: 'no-file' }
  );
});

test('a failed copy persists null, never a placeholder', () => {
  // A row that claims an asset id it does not have is worse than one that
  // admits it has none: recovery would select it, fail to resolve it, and the
  // user would still be told the footage was safe.
  assert.equal(resolvePersistedAssetId({ action: 'mirror' }, null), null);
  assert.equal(resolvePersistedAssetId({ action: 'mirror' }, ''), null);
  assert.equal(resolvePersistedAssetId({ action: 'mirror' }, 'new-1'), 'new-1');
  assert.equal(
    resolvePersistedAssetId({ action: 'reuse', assetId: 'ph-1' }, null),
    'ph-1'
  );
  assert.equal(
    resolvePersistedAssetId({ action: 'skip', reason: 'setting-off' }, 'ignored'),
    null
  );
});

// ── the copy on Storage & Backup ────────────────────────────────────────

test('the tick is never earned by the toggle alone', () => {
  // The exact false reassurance this change exists to remove: switch on,
  // clips already recorded, nothing in the camera roll.
  const status = describeRawClipStatus({
    mirrorOn: true,
    permission: 'granted',
    stats: { total: 12, mirrored: 0 },
  });
  assert.equal(status.ok, false);
  assert.match(status.text, /12/, 'the user should be told how much is unprotected');
});

test('a partial mirror is a warning, not a tick', () => {
  // Most users after this fix: some clips captured with mirroring on, the rest
  // of their history without. A reinstall still loses footage, so it must not
  // read as safe.
  for (const [mirrored, total] of [[1, 2], [7, 8], [2, 40]]) {
    const status = describeRawClipStatus({
      mirrorOn: true,
      permission: 'granted',
      stats: { total, mirrored },
    });
    assert.equal(status.ok, false, `${mirrored}/${total} must not read as safe`);
    assert.match(status.text, new RegExp(String(total - mirrored)));
  }
});

test('the tick requires every clip on the phone to have a copy', () => {
  const status = describeRawClipStatus({
    mirrorOn: true,
    permission: 'granted',
    stats: { total: 9, mirrored: 9 },
  });
  assert.equal(status.ok, true);
  assert.match(status.text, /re-import/);
});

test('facts outrank the switch in both directions', () => {
  // Toggle off but every clip already copied → they DO survive a reinstall.
  assert.equal(
    describeRawClipStatus({
      mirrorOn: false,
      permission: 'granted',
      stats: { total: 3, mirrored: 3 },
    }).ok,
    true
  );
  // Toggle on but Photos access missing → nothing is being copied, whatever
  // the switch shows.
  for (const permission of ['denied', 'undetermined', 'unavailable'] as const) {
    const status = describeRawClipStatus({ mirrorOn: true, permission, stats: null });
    assert.equal(status.ok, false, `permission=${permission} must not read as safe`);
  }
});

test('with no clips yet the copy promises only future clips', () => {
  const status = describeRawClipStatus({
    mirrorOn: true,
    permission: 'granted',
    stats: { total: 0, mirrored: 0 },
  });
  assert.equal(status.ok, true);
  assert.match(
    status.text,
    /from now on/,
    'the promise must be scoped to clips not yet captured'
  );
});

test('an unreadable count never becomes a claim about existing footage', () => {
  const status = describeRawClipStatus({
    mirrorOn: true,
    permission: 'granted',
    stats: null,
  });
  assert.match(status.text, /from now on/);
});

// ── 2. the wiring: both paths, one helper ───────────────────────────────

test('the record path mirrors at all', () => {
  // The whole finding in one assertion: hooks/useCamera.ts contained zero
  // references to MediaLibrary or photos_asset_id, so a recorded clip was
  // never copied and never recoverable.
  assert.match(
    useCamera,
    /import \{ mirrorRecordedClip \} from '@\/lib\/photosMirror'/,
    'the record path must honour "Save raw clips to Photos"'
  );
  assert.match(useCamera, /void mirrorRecordedClip\(clipId, finalUri\)/);
});

test('mirroring cannot cost the recording', () => {
  // Order and awaiting are the whole safety story: the SQLite row must exist
  // before Photos is touched, and the copy must never be awaited on the path
  // between the golfer and their next shot.
  const saveAt = useCamera.indexOf('const clipId = await saveLocalClip(');
  const mirrorAt = useCamera.indexOf('void mirrorRecordedClip(');
  assert.notEqual(saveAt, -1, 'expected the clip insert in useCamera.ts');
  assert.notEqual(mirrorAt, -1);
  assert.ok(saveAt < mirrorAt, 'the clip row must be inserted before we touch Photos');
  assert.doesNotMatch(
    useCamera,
    /await mirrorRecordedClip\(/,
    'the record path must not await the Photos copy'
  );
  assert.match(
    useCamera,
    /InteractionManager\.runAfterInteractions\(\(\) => \{\s*void mirrorRecordedClip\(/,
    'the copy must be deferred off the recording hot path'
  );
});

test('a mirroring failure returns null instead of throwing', () => {
  // mirrorClipToPhotos is called with `void` from a background task; a throw
  // there is an unhandled rejection, and on some paths a crash — over a clip
  // that is already safely on disk.
  assert.doesNotMatch(
    mirror,
    /^\s*throw\s/m,
    'lib/photosMirror must swallow every failure — the clip already exists'
  );
  assert.match(mirror, /catch \(err\)[\s\S]{0,400}?return null;/);
});

test('both paths go through the one helper, and no path talks to Photos itself', () => {
  assert.match(
    importScreen,
    /mirrorClipToPhotos\(\{/,
    'the import path must use the shared helper, not its own MediaLibrary block'
  );
  for (const [name, src] of [
    ['hooks/useCamera.ts', useCamera],
    ['app/round/import.tsx', importScreen],
  ] as const) {
    assert.doesNotMatch(
      src,
      /MediaLibrary\.(createAssetAsync|requestPermissionsAsync|getPermissionsAsync)/,
      `${name} must not drive MediaLibrary directly — that is how the two paths diverged`
    );
  }
});

test('nothing else in the app grows its own clip-mirroring code', () => {
  // The guard against a THIRD capture path (share extension, watch companion,
  // a re-record flow) quietly repeating the original mistake. lib/sharing.ts
  // is a different feature — it puts finished highlight REELS in a Clippar
  // album, not raw clips — so it is named here deliberately, not by accident.
  const allowedAssetWriters = new Set(['lib/photosMirror.ts', 'lib/sharing.ts']);
  const allowedIdWriters = new Set(['lib/storage.ts', 'lib/photosMirror.ts']);

  for (const file of sourceFiles()) {
    const src = readFileSync(join(root, file), 'utf8');
    if (/MediaLibrary\.createAssetAsync\s*\(/.test(src)) {
      assert.ok(
        allowedAssetWriters.has(file),
        `${file} creates Photos assets on its own. Raw clips must go through mirrorClipToPhotos (lib/photosMirror.ts) so every capture path agrees on when to mirror — see lib/photosMirrorPolicy.ts.`
      );
    }
    if (/setClipPhotosAssetId\s*\(/.test(src)) {
      assert.ok(
        allowedIdWriters.has(file),
        `${file} writes photos_asset_id directly. Let lib/photosMirror.ts own that write so a row can never claim a Photos copy that was never made.`
      );
    }
  }
});

test('the two paths persist the same thing in the same column', () => {
  // Import knows the id before its row exists; record's row exists first and
  // the id arrives later. Different ordering, deliberately — but the value
  // and the column must be identical or recovery sees only one of them.
  assert.match(
    importScreen,
    /photos_asset_id: photosAssetId,/,
    'import must persist the helper result onto the clip row'
  );
  assert.match(
    mirror,
    /await setClipPhotosAssetId\(clipId, assetId\)/,
    'record must persist the helper result onto the clip row'
  );
  assert.match(
    storage,
    /export async function setClipPhotosAssetId/,
    'both writes land in local_clips.photos_asset_id'
  );
});

test('recovery selects exactly what the mirror writes', () => {
  assert.match(recovery, /getClipsWithPhotosAssetId/);
  assert.match(
    storage,
    /WHERE photos_asset_id IS NOT NULL AND photos_asset_id != ''/,
    'the recovery query is what "mirrored" means'
  );
});

// ── the permission story ────────────────────────────────────────────────

test('the record path can never raise a permission dialog', () => {
  // Spec 6.5: a clicker press must not raise a permission dialog, and the
  // record path runs moments after a shot over a live camera.
  assert.match(
    mirror,
    /promptForPermission: false/,
    'mirrorRecordedClip must opt out of prompting'
  );
  const recordAt = mirror.indexOf('export async function mirrorRecordedClip');
  assert.notEqual(recordAt, -1);
  assert.doesNotMatch(
    mirror.slice(recordAt),
    /requestPhotosMirrorPermission\(/,
    'the record path must read the permission, never ask for it'
  );
});

test('the import path still asks, because it is a foreground action', () => {
  // Users who enabled the toggle before it requested permission depend on
  // this prompt; dropping it would strand them silently.
  assert.match(importScreen, /promptForPermission: true/);
});

test('turning the setting on asks for Photos access first', () => {
  // Without this the switch can be ON with permission undetermined forever —
  // set, reassuring, and silently copying nothing.
  const askAt = settings.indexOf('requestPhotosMirrorPermission()');
  const writeAt = settings.indexOf('setMirrorClipsToPhotos(val)');
  assert.notEqual(askAt, -1, 'the toggle must request Photos permission');
  assert.notEqual(writeAt, -1);
  assert.ok(askAt < writeAt, 'permission must be resolved before the setting is stored');
  assert.match(
    settings,
    /if \(!granted\) \{[\s\S]{0,600}?return;/,
    'a refused permission must leave the setting off, not on-and-broken'
  );
});

// ── the reassurance ─────────────────────────────────────────────────────

test('Storage & Backup states a fact, not the switch position', () => {
  assert.doesNotMatch(
    settings,
    /ok=\{mirrorClips\}/,
    'the raw-clips tick must not be keyed on the toggle — that is the false reassurance'
  );
  assert.match(settings, /describeRawClipStatus\(\{/);
  assert.match(settings, /getClipMirrorStats/, 'the card must count real rows');
  assert.doesNotMatch(
    settings,
    /Raw clips — mirrored to Photos, will re-import on reinstall/,
    'the old unconditional claim must be gone'
  );
});

test('the count means the same thing as recovery', () => {
  // If getClipMirrorStats counted rows recovery would skip, the tick would go
  // green over clips that cannot come back — the same lie, one screen along.
  const statsAt = storage.indexOf('export async function getClipMirrorStats');
  assert.notEqual(statsAt, -1);
  const body = storage.slice(statsAt, statsAt + 900);
  assert.match(
    body,
    /photos_asset_id IS NOT NULL AND photos_asset_id != ''/,
    'getClipMirrorStats must use the recovery predicate verbatim'
  );
});

function sourceFiles(): string[] {
  const out: string[] = [];
  // `.claude` holds agent scaffolding — including git worktrees, which are
  // FULL copies of this repo. Walking into one makes every guard below fire on
  // a second copy of app/round/import.tsx and report the approved call site as
  // an unauthorized one, from a path no reader recognises. Source policed here
  // must be the source that ships.
  const skip = new Set([
    'node_modules', '.git', '.expo', '.claude', 'ios', 'android', 'dist', 'tests',
  ]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}
