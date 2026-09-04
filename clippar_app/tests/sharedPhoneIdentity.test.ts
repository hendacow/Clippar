import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * "The app never forgets who was last signed in."
 *
 * storage.ts caches the last successfully resolved user id (`lastKnownUserId`)
 * so a transient getSession() failure mid-round does not hide a golfer's own
 * round from them. Nothing cleared that cache at sign-out, and its docstring
 * asserted a guarantee that had no implementation anywhere. So on a shared
 * handset:
 *
 *   1. A uses the app  → lastKnownUserId = A
 *   2. A signs out, B signs in — the global still reads A
 *   3. B's first identity check hits the error branch (a token refresh with no
 *      signal returns a retryable fetch error; a Keychain-busy read throws)
 *      → B is handed A's id
 *   4. every scoped read answers for A: B is offered A's "Unfinished round",
 *      with A's scores, locations and playable swing videos
 *
 * This is live in the shipped app, not only on this branch.
 *
 * The fix has one moving part and one deliberate omission, and the omission is
 * the whole reason two patches were circulating: clearing `legacyRoundsClaimed`
 * in the same function would harden this while making the NULL-owner round
 * claim fire on the very next sign-in — the same handover, worse.
 *
 * Structural assertions, because the resolver itself cannot be imported here
 * (expo-sqlite at module load). Each one fails on the pre-fix tree.
 */

const root = join(import.meta.dirname, '..');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
const useAuth = readFileSync(join(root, 'hooks/useAuth.ts'), 'utf8');
const wipe = readFileSync(join(root, 'lib/localWipe.ts'), 'utf8');

const forgetFn =
  storage.match(/export function forgetCachedSessionUser\(\)[\s\S]*?\n\}/)?.[0] ?? '';

test('storage exports something that clears the remembered account', () => {
  assert.notEqual(forgetFn, '', 'forgetCachedSessionUser() must exist and be exported');
  assert.match(forgetFn, /lastKnownUserId\s*=\s*null/, 'it clears the cached id');
});

test('it clears ONLY the cached id — never the legacy-claim latch', () => {
  // The trap. shouldClaimLegacyRows() is `!!sessionUserId && !alreadyClaimed`,
  // so the latched flag is the only thing stopping
  //   UPDATE local_rounds SET user_id = ? WHERE user_id IS NULL
  // running twice in a process. Resetting it at sign-out re-arms it for the
  // next sign-in, which is precisely the A-out/B-in handover.
  assert.doesNotMatch(
    forgetFn,
    /legacyRoundsClaimed/,
    'forgetCachedSessionUser must not touch legacyRoundsClaimed'
  );
});

test('the sign-out path actually calls it, in the SIGNED_OUT branch', () => {
  const branch = useAuth.match(/if \(event === 'SIGNED_OUT'\)[\s\S]*?\n {6}\}/)?.[0] ?? '';
  assert.notEqual(branch, '', 'the SIGNED_OUT branch must still exist');
  assert.match(
    branch,
    /forgetCachedSessionUser\(\)/,
    'SIGNED_OUT must forget the cached account — it also covers a remote revoke and a refresh-token failure'
  );
});

test('account deletion forgets the account too, and only after the sweeps', () => {
  const fn = wipe.match(/export async function wipeLocalUserData[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fn, '');
  assert.match(fn, /forgetCachedSessionUser\(\)/);
  // clearLocalDatabase fails CLOSED with no resolvable owner, so forgetting the
  // id before it runs would make an account deletion delete nothing at all.
  assert.ok(
    fn.indexOf('clearLocalDatabase()') < fn.indexOf('forgetCachedSessionUser()'),
    'the sweeps must resolve the departing user before the id is forgotten'
  );
  // And before the web early-return, or it never runs on web.
  assert.ok(
    fn.indexOf('forgetCachedSessionUser()') < fn.indexOf("Platform.OS === 'web'"),
    'the forget must run on every platform'
  );
});

test('the lenient in-round fallback survives — an offline start must still work', () => {
  // The point of the cache is that a golfer mid-round with no signal keeps
  // seeing their own round. The fix clears it at sign-out, not at every
  // failure, so this branch must remain.
  const resolver = storage.match(/async function sessionUserId\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(resolver, '');
  assert.match(resolver, /if \(error\) return lastKnownUserId/);
  assert.match(resolver, /catch \{\s*\n\s*return lastKnownUserId;/);
});

/**
 * Same handset, second half: the orphan sweep in account deletion must not fail
 * OPEN. allReferencedClipFileUris() used to swallow a read error and return an
 * EMPTY set, with a comment claiming that meant "the sweep deletes nothing" —
 * it meant every file looked like an orphan and the whole clips/ and exports/
 * trees went, which is the bug the sweep was rewritten to prevent.
 */
test('the orphan sweep skips itself when the reference set cannot be read', () => {
  const refs =
    storage.match(/export async function allReferencedClipFileUris[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(refs, '');
  assert.match(refs, /Promise<Set<string> \| null>/, 'failure is signalled, not swallowed');
  assert.match(refs, /return null;/);

  const sweep = wipe.match(/async function removeOwnedMediaDirectories[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(sweep, /if \(!referenced\) return;/, 'no reference set → no sweep');
  assert.ok(
    sweep.indexOf('if (!referenced) return;') < sweep.indexOf('deleteAsync'),
    'the guard must precede any delete'
  );
});
