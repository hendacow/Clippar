import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const wipe = readFileSync(join(root, 'lib/localWipe.ts'), 'utf8');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');

// Shared handset, gate item for the 2 Sep submit: deleting account A must
// never destroy account B's irreplaceable footage. clearLocalDatabase was
// already scoped; the directory sweep in localWipe was NOT and undid it.
test('the account-deletion media sweep deletes orphans only, never a referenced file', () => {
  const fn = wipe.match(/async function removeOwnedMediaDirectories[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fn, '');
  assert.doesNotMatch(fn, /deleteAsync\(`\$\{root\}\$\{dir\}`/, 'the whole-directory delete is gone');
  assert.match(fn, /allReferencedClipFileUris/, 'it cross-checks live rows first');
  assert.match(fn, /if \(referenced\.has\(fileUri\)\) continue/, 'a referenced file is kept');
});

test('the reference check spans ALL accounts, not just the deleting one', () => {
  const fn = storage.match(/export async function allReferencedClipFileUris[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri FROM local_clips/);
  assert.doesNotMatch(fn, /WHERE/, 'no owner filter — every surviving row protects its file');
});

test('clearLocalDatabase still fails closed with no resolvable owner', () => {
  assert.match(storage, /refusing to wipe/);
  assert.match(storage, /DELETE FROM local_rounds       WHERE user_id = \?/);
});
