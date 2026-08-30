import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
const player = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');

/**
 * The bug, stated as a test.
 *
 * `training.sessions.v1` is a device-wide `local_settings` row and
 * `getClipsForRound` has no ownership predicate. Together: B signs in on A's
 * handset, opens Practice, sees A's sessions with true per-club shot counts,
 * taps Watch, and app/training/play.tsx plays A's swing videos. The editor
 * route off the same screen was already safe (useEditorState.loadFromLocal
 * gates on the scoped getLocalRound); the player was not.
 */

test('getClipsForRound really is unscoped, which is why callers must gate', () => {
  const body = storage.match(/export async function getClipsForRound[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(body, '', 'getClipsForRound should still exist');
  assert.match(
    body,
    /SELECT \* FROM local_clips WHERE round_id = \?/,
    'no ownership predicate here — the gate has to live in the caller'
  );
  assert.doesNotMatch(body, /ownedRoundsClause|currentScopeUserId/);
});

test('the player reads clips through the gated helper, not the raw store', () => {
  assert.match(player, /listTrainingClips/);
  assert.doesNotMatch(
    player,
    /getClipsForRound/,
    'the player must not reach past the ownership gate'
  );
});

test('every training read and write gates on ownership', () => {
  // This used to assert `getLocalRound(roundId)) != null` VERBATIM, which
  // pinned the weaker form in place: `!= null` only says somebody's row came
  // back, and getLocalRound resolves the session on its own, so the stamp and
  // the row were authorised by two answers nothing compared. Strengthening the
  // gate turned this assertion red — the test was holding the defect.
  //
  // Same shape as the `startsWith('file://')` pin and the call-site count: the
  // assertion watched the shape of the code rather than the property.
  assert.match(
    training,
    /async function ownsRound[\s\S]*?round != null && round\.user_id === me/,
    'ownership needs the scoped read AND the row bound back to this resolution'
  );

  for (const fn of ['listTrainingClips', 'trainingShotCounts', 'importShotsToSession']) {
    const body = training.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.match(body, /await ownsRound\(roundId\)/, `${fn} must gate on ownership`);
  }
});

// The capture screen got the deep-link gate; its sibling did not. Both take
// roundId from the URL, and import.tsx opens the OS photo library — the same
// privacy prompt the capture fix moved behind the check.
test('the import screen is gated too, not just capture', () => {
  const imp = readFileSync(join(root, 'app/training/import.tsx'), 'utf8');
  assert.match(imp, /ownsTrainingRound/, 'the import screen must check ownership');
  assert.match(
    imp,
    /const owned: boolean \| null = !roundId\s*\?\s*false\s*:\s*verdict\?\.roundId === roundId/,
    'derived in render, same shape as record.tsx — a stale verdict must not survive a param change'
  );
  assert.match(
    imp,
    /if \(!ImagePicker \|\| !roundId \|\| owned !== true \|\| busy\) return;/,
    'the photo library must not open for a round nothing has verified'
  );
  // importShotsToSession fails closed and returns 0 for BOTH "not yours" and
  // "no session". Reporting that as a success told a golfer their own import
  // had worked when it had not.
  assert.match(imp, /if \(saved === 0\) \{/, 'a refused or failed import must not report success');
  const pick = imp.match(/const pick = useCallback[\s\S]*?\}, \[roundId, club, busy, owned\]\);/)?.[0] ?? '';
  assert.notEqual(pick, '', 'pick must re-run when the ownership verdict resolves');
  assert.ok(
    pick.indexOf('owned !== true') < pick.indexOf('launchImageLibraryAsync'),
    'the ownership check must precede the picker, not follow it'
  );
});

test('the session list only offers the signed-in account’s own sessions', () => {
  const body = training.match(/export async function listTrainingSessions[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(body, /await ownsRound\(s\.roundId\)/);
});

// Shots enter a session two ways. Gating the import and leaving live capture
// open protects one of them — the same half-covered mistake the reads had.
// app/training/record.tsx takes roundId from the URL, app.config.js registers a
// URL scheme, and useCamera's save path is a bare saveLocalClip({ round_id })
// with no ownership predicate.
test('live capture is gated too, not just the import path', () => {
  const record = readFileSync(join(root, 'app/training/record.tsx'), 'utf8');
  assert.match(record, /ownsTrainingRound/, 'the capture screen must check ownership');
  assert.match(training, /export async function ownsTrainingRound/);
  // The camera is armed on mount while the check is still resolving, so the
  // binding is gated, not merely the render.
  assert.match(
    record,
    /roundId: owned === true \? \(roundId \?\? ''\) : ''/,
    'the useCamera binding must not carry an unverified round id'
  );
  assert.match(record, /if \(owned === false\)/, 'an unowned session must not render the camera');
  // The verdict must not outlive the id it was made for: expo-router updates
  // params in place, so a second deep link re-renders rather than remounting.
  //
  // Resetting it from an effect is not enough — effects run after the render
  // commits, so one painted frame carried the previous round's `true` against
  // the new, unverified id, and the camera binding above read it. The verdict
  // therefore carries the id it was computed for and `owned` is derived during
  // render, which invalidates a stale answer in the same commit as the new id.
  assert.doesNotMatch(
    record,
    /setOwned\(/,
    'a verdict held in plain state can be read one render before its reset lands'
  );
  assert.match(
    record,
    /setVerdict\(\{ roundId, owned: ok \}\)/,
    'the stored verdict must be stamped with the id it was computed for'
  );
  assert.match(
    record,
    /const owned: boolean \| null = !roundId\s*\?\s*false\s*:\s*verdict\?\.roundId === roundId\s*\?\s*verdict\.owned\s*:\s*null;/,
    'owned must be derived in render from a verdict matching the CURRENT roundId'
  );
  const effect = record.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[roundId\]\);/)?.[0] ?? '';
  // The permission prompt must sit behind the check too — effects run after
  // the first render, so gating the hydrate effect on roundId alone fired the
  // OS camera prompt for a round nothing had verified.
  assert.match(record, /if \(!roundId \|\| owned !== true\) return;/, 'hydrate must wait for ownership');
  assert.match(record, /\}, \[roundId, owned\]\);/, 'and re-run when it resolves');
  assert.match(effect, /ownsTrainingRound\(roundId\)/, 'the ownership effect should still exist');
  assert.doesNotMatch(
    effect,
    /setVerdict\((?!\{ roundId,)/,
    'every write from this effect must stamp the id, including the catch path'
  );
});

// The writer half of the same rule.
//
// Every READ gate on this branch fails closed on an unresolvable session:
// listTrainingSessions returns [], ownsRound returns false, the sweep returns
// 0. The two registry WRITERS did the opposite — they stamped `userId: null`
// and carried on. Null is read everywhere as "legacy, unattributable", so such
// an entry is never listed to the golfer who recorded it, and never removed by
// forgetTrainingSessionsFor — leaving the round id and the session's start
// timestamp in device-wide local_settings after account deletion. A writer
// that fails open hands the gates a value they cannot act on.
test('startTrainingSession refuses an unresolvable session instead of stamping null', () => {
  const start = training.match(/export async function startTrainingSession[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(start, '', 'startTrainingSession should still exist');
  assert.match(start, /if \(!owner\) throw/, 'an unresolvable session must refuse, not stamp null');
  assert.ok(
    start.indexOf('if (!owner) throw') < start.indexOf('await createRound('),
    'the refusal must precede the remote create, so a refusal leaves no round behind'
  );
  assert.match(start, /userId: owner/, 'the stamp must carry the value that was checked');
  assert.equal(
    (start.match(/currentSessionUserId\(\)/g) ?? []).length,
    1,
    'resolve once and reuse it — a second read can answer differently'
  );
});

// The read side must keep tolerating null, or genuinely pre-stamp rows written
// by a shipped build become unreadable. The property is only that no NEW one
// can be minted.
test('legacy null-owner entries are still tolerated on read', () => {
  assert.match(
    training,
    /userId: string \| null/,
    'the entry type must still admit null for rows written before the stamp existed'
  );
});
