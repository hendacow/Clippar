import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const tutorial = readFileSync(join(root, 'lib/tutorialRound.ts'), 'utf8');
const record = readFileSync(join(root, 'app/(tabs)/record.tsx'), 'utf8');

const sweep = tutorial.match(/export async function sweepTutorialRounds[\s\S]*?\n}/)?.[0] ?? '';

// The bug, stated as a test. sweepTutorialRounds deletes local rows, unlinks
// every clip file and deletes the remote round, and it runs on every authed
// app start. It used to choose its victims with
// `o.course_name === TUTORIAL_COURSE_NAME` over getOrphanedRounds() — but
// course_name is typed by the user on the round-setup screen, so naming a
// course "Tutorial round" destroyed that round on the next launch.
test('course_name really is user-typed, which is why it cannot be the sentinel', () => {
  assert.match(record, /onChangeText=\{setCourseName\}/, 'course name is a free-text input');
});

test('the sweep does not select rounds by course name alone', () => {
  assert.notEqual(sweep, '', 'sweepTutorialRounds should still exist');
  assert.doesNotMatch(
    sweep,
    /getOrphanedRounds/,
    'scanning all in-progress rounds lets a user-typed name select a real round'
  );
});

test('candidates come from the created-id registry', () => {
  assert.match(sweep, /readCreatedIds\(\)/, 'the sweep must work from ids the app itself created');
  assert.match(
    tutorial,
    /export async function createTutorialRound[\s\S]*?writeCreatedIds/,
    'createTutorialRound must register the id it created'
  );
});

// Belt and braces: even inside the registry, a row that is not a tutorial
// round is left alone.
test('the course-name check survives as a second gate', () => {
  assert.match(sweep, /course_name !== TUTORIAL_COURSE_NAME/);
});

// The registry must not grow for the life of the install.
test('swept ids are dropped from the registry', () => {
  assert.match(sweep, /writeCreatedIds\(/);
});

// local_settings is device-wide, so a bare id list accumulates rounds from
// every account that has used the handset. getLocalRound is scoped and fails
// closed, so under account B a round of A's reads as null — which the sweep
// treats as "already gone locally" and proceeds. deleteLocalRound is NOT
// scoped: it deletes by round_id alone and unlinks every clip file it finds.
test('registry entries carry their owner and only the owner sweeps them', () => {
  assert.match(
    tutorial,
    /interface CreatedTutorialRound[\s\S]*?userId: string \| null/,
    'entries must record who created them'
  );
  assert.match(
    sweep,
    /created\.filter\(\(e\) => e\.userId === me\)/,
    'only the signed-in account’s rounds may be candidates'
  );
  assert.match(sweep, /if \(!me\) return 0;/, 'no session must sweep nothing');
  assert.match(
    tutorial,
    /export async function createTutorialRound[\s\S]*?userId: owner/,
    'creation must stamp the owner'
  );
});

test('another account’s entries survive a sweep, and legacy entries are never swept', () => {
  // Preserved so A's round is still collected next time A signs in.
  assert.match(sweep, /created\.filter\(\(e\) => !sweptIds\.has\(e\.id\)\)/);
  // The previous string[] shape has no known owner; keep it, never sweep it.
  assert.match(tutorial, /typeof v === 'string'\) return \[\{ id: v, userId: null \}\]/);
});

// The device-wide active-round key carries no owner, so it must not be a
// candidate — an id that reached it without reaching the registry cannot be
// attributed to anyone.
test('the unattributable active-round key is not a sweep candidate', () => {
  assert.doesNotMatch(sweep, /candidates\.add\(active\)/);
});

// Removing the orphan scan made the registry the ONLY record of a tutorial
// round, so retiring an id after a failed delete strands that round forever:
// deleteRound is a network call that throws, and being offline at app start is
// routine. Both deletes must succeed before the id is forgotten.
test('an id is retired only when both deletes succeed', () => {
  assert.doesNotMatch(
    sweep,
    /deleteRound\(id\)\.catch\(/,
    'swallowing the remote delete loses the only record that it still needs doing'
  );
  assert.match(sweep, /localOk/, 'the local delete result must be observed');
  assert.match(sweep, /remoteOk/, 'the remote delete result must be observed');
  assert.match(
    sweep,
    /if \(!localOk \|\| !remoteOk\) continue;/,
    'a partial failure must leave the id in the registry to retry'
  );
});
