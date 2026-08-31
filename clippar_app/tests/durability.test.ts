import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
const restore = readFileSync(join(root, 'lib/restore.ts'), 'utf8');
const mirror = readFileSync(join(root, 'lib/photosMirror.ts'), 'utf8');
const home = readFileSync(join(root, 'app/(tabs)/index.tsx'), 'utf8');
const media = readFileSync(join(root, 'lib/media.ts'), 'utf8');
const settings = readFileSync(join(root, 'app/profile/storage-settings.tsx'), 'utf8');

// Durability plan, ratified 1 Sep. Defaults: mirroring ON unless explicitly
// off; cloud backup EFFECTIVE-on for Pro unless explicitly off.
test('mirroring defaults on; explicit off is always respected', () => {
  assert.match(storage, /getSetting\(SETTING_MIRROR_CLIPS\)\) !== '0'/);
});

test("Pro's cloud backup defaults on via the effective getter", () => {
  assert.match(storage, /export async function getCloudBackupEffective/);
  assert.match(storage, /if \(raw === '0'\) return false;/, 'explicit off wins over Pro');
  assert.match(storage, /getProStatus\(\)/);
  const queue = readFileSync(join(root, 'lib/uploadQueue.ts'), 'utf8');
  assert.match(queue, /getCloudBackupEffective/);
  assert.doesNotMatch(queue, /getCloudBackupEnabled\(\)/, 'the queue never reads the raw setting');
});

// The album IS the reinstall index.
test('mirrored shots file into the Clippar album, and album failure never fails the mirror', () => {
  assert.match(mirror, /CLIPPAR_ALBUM = 'Clippar'/);
  assert.match(mirror, /addAssetsToAlbumAsync|createAlbumAsync/);
  assert.match(mirror, /asset saved but album filing failed/);
});

// Metadata rows for everyone; the Pro boundary in writing where it lives.
test('every saved clip syncs a metadata row, and the Pro boundary is stated in the code', () => {
  assert.match(restore, /export async function syncShotMetadata/);
  assert.match(restore, /Only Pro's video upload survives a[\s\S]{0,20}LOST phone/i);
  const cam = readFileSync(join(root, 'hooks/useCamera.ts'), 'utf8');
  assert.match(cam, /syncShotMetadata\(/);
  const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
  assert.match(training, /syncShotMetadata/);
});

// The mixed-restore answer: detect, say it plainly, offer the way forward.
test('a device restore is detected and told honestly, never left looking restored', () => {
  assert.match(restore, /export async function detectMissingMedia/);
  assert.match(home, /Some round videos aren't on this phone/);
  assert.match(home, /Restore from Photos/);
  assert.match(media, /Do not "fix" this\n \* asymmetry/, 'the deliberate backup asymmetry is documented at the code');
});

// The hybrid: re-linked clips are COPIED back into app storage.
test('re-link copies assets back into app storage (the app owns its copy)', () => {
  assert.match(restore, /persistAsset\(src, filename, \{ keepSource: true \}\)/);
  assert.match(restore, /shouldDownloadFromNetwork: true/);
});

// The two-losses framing is in the user-facing copy, both sentences.
test('storage settings says both sentences of the two-losses framing', () => {
  assert.match(settings, /does NOT protect against losing your phone/i);
  assert.match(settings, /survive a LOST or replaced phone/);
});
