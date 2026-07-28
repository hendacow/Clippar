import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MEDIA-001. ShareSheet used to call getShareUrl(roundId) from the effect that
// fires on `visible`, so merely OPENING the share sheet ran
// ensureReelUploaded → uploadReelToStorage: the whole stitched reel, video and
// original ambient audio, was pushed to Supabase and given a permanent
// share_token before the user chose anything — overriding the (default-off,
// Pro-gated) cloud-backup opt-out, with no progress UI and no undo on dismiss.
//
// The guarantee is about WHERE a call sits, not about a value, so it is
// asserted against the source. A rendering test would not catch someone moving
// the call back into the effect while keeping the confirmation dialog around.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', 'components', 'shared', 'ShareSheet.tsx'),
  'utf8'
);

// Comments are stripped first: the prose in ShareSheet explains this very
// attack and names the functions involved, and a test that counted mentions
// rather than calls would flip on a wording change.
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Slice one arrow-function declaration out, up to the next one. */
function bodyOf(decl: string): string {
  const start = code.indexOf(decl);
  assert.notEqual(start, -1, `expected ${decl} in ShareSheet`);
  const rest = code.slice(start + decl.length);
  const next = rest.search(/\n {2}(const \w+|return \()/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('opening the share sheet performs no upload and mints no share link', () => {
  const start = code.indexOf('useEffect(');
  assert.notEqual(start, -1, 'expected a useEffect in ShareSheet');
  const end = code.indexOf('}, [visible, roundId]);', start);
  assert.notEqual(end, -1, 'expected the visibility effect to depend on [visible, roundId]');
  const body = code.slice(start, end);

  for (const forbidden of ['getShareUrl', 'ensureReelUploaded', 'uploadReelToStorage']) {
    assert.equal(
      body.includes(forbidden),
      false,
      `${forbidden} must not run just because the sheet became visible`
    );
  }
});

test('getShareUrl has exactly one call site, inside the copy-link handler', () => {
  const calls = code.match(/getShareUrl\s*\(/g) ?? [];
  assert.equal(calls.length, 1, 'the upload path must have a single entry point');
  assert.ok(
    bodyOf('const mintAndCopyLink').includes('getShareUrl('),
    'getShareUrl must be reached only from the user-initiated copy-link handler'
  );
});

test('the copy-link handler asks before uploading', () => {
  const body = bodyOf('const handleCopyLink');
  assert.ok(body.includes('Alert.alert('), 'copy-link must confirm before uploading');
  // The dialog has to say what actually happens, not just "are you sure".
  assert.ok(/uploads this reel/i.test(body), 'the confirmation must state that it uploads');
  assert.ok(/style: 'cancel'/.test(body), 'the confirmation must be refusable');
  assert.ok(
    body.indexOf('Alert.alert(') < body.indexOf('mintAndCopyLink()'),
    'the upload must be gated behind the confirmation, not run alongside it'
  );
});

test('the local-only share actions never reach the upload path', () => {
  // Save to Camera Roll, the native share sheet and Instagram Stories all work
  // off the local reel file and must stay off the network.
  for (const decl of [
    'const handleSaveToGallery',
    'const handleShare =',
    'const handleInstagramStories',
  ]) {
    assert.equal(
      bodyOf(decl).includes('getShareUrl'),
      false,
      `${decl} must not mint a share link`
    );
  }
});
