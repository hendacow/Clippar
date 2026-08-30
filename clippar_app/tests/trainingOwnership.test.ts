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
  assert.match(
    training,
    /async function ownsRound[\s\S]*?getLocalRound\(roundId\)\) != null/,
    'ownership must be decided by the scoped, fail-closed getLocalRound'
  );

  for (const fn of ['listTrainingClips', 'trainingShotCounts', 'importShotsToSession']) {
    const body = training.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.match(body, /await ownsRound\(roundId\)/, `${fn} must gate on ownership`);
  }
});

test('the session list only offers the signed-in account’s own sessions', () => {
  const body = training.match(/export async function listTrainingSessions[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(body, /await ownsRound\(s\.roundId\)/);
});
