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

// Both filters in the module read `userId: null` as "legacy, unattributable":
// the sweep never selects one and the account-deletion scrub never removes one.
// So a writer that stamps null does not degrade a record, it mints a permanent
// one — and makes the documented invariant ("null = a pre-stamp bare string")
// false. Every read gate on this branch fails closed on an unresolvable
// session; the two writers did not, and this pins them to the same rule.
test('a null owner is refused rather than stamped, and refused before the remote create', () => {
  const create = tutorial.match(/export async function createTutorialRound[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(create, '', 'createTutorialRound should still exist');
  assert.match(create, /if \(!owner\) throw/, 'an unresolvable session must refuse, not stamp null');
  assert.ok(
    create.indexOf('if (!owner) throw') < create.indexOf('await createRound('),
    'the refusal must precede the remote create, or it strands a round the registry never records'
  );
  // The stamp itself must carry the checked value, not a re-resolution: two
  // reads can disagree, which is the defect this branch fixed three times.
  assert.match(create, /userId: owner/);
  assert.equal(
    (create.match(/currentSessionUserId\(\)/g) ?? []).length,
    1,
    'resolve once and reuse it — a second read can answer differently'
  );
});

test('candidates come from the created-id registry', () => {
  assert.match(sweep, /readCreatedIds\(\)/, 'the sweep must work from ids the app itself created');
  assert.match(
    tutorial,
    /export async function createTutorialRound[\s\S]*?mutateCreatedIds/,
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
  assert.match(sweep, /mutateCreatedIds\(/);
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
  // Preserved so A's round is still collected next time A signs in: the write
  // removes ONLY swept ids, so every other entry survives whatever its owner.
  //
  // This used to pin `created.filter(...)` — the pre-loop snapshot — by name,
  // which required the lost-update bug: the loop awaits a network delete, and
  // writing that snapshot back undid any registry change made meanwhile,
  // including the account-deletion scrub. Fixing it turned this red. Fourth
  // assertion tonight watching the shape of the code rather than the property.
  assert.match(sweep, /\.filter\(\(e\) => !sweptIds\.has\(e\.id\)\)/);
  // The write must read AFTER the awaits, not before them — and the whole
  // read-modify-write must be serialised, which is strictly stronger. Re-reading
  // narrowed the window between the sweep and the account-deletion scrub; the
  // queue closes it. Every writer of the key goes through the same helper: a
  // lock one writer skips is not a lock.
  assert.match(
    sweep,
    /await mutateCreatedIds\(\(entries\) => entries\.filter/,
    'the tail must re-read under the queue, or a concurrent scrub is reverted'
  );
  const tutorial2 = readFileSync(join(root, 'lib/tutorialRound.ts'), 'utf8');
  // The PROPERTY: the read and the write happen inside one queued job, so no
  // other writer can land between them. This used to pin the helper's exact
  // one-line body and went red the moment the read was split into a strict
  // variant — eighth assertion tonight watching the shape instead of the rule.
  const helper = tutorial2.match(/async function mutateCreatedIds[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(helper, '', 'mutateCreatedIds should still exist');
  const runAt = helper.indexOf('registryQueue.run(');
  assert.notEqual(runAt, -1, 'the read-modify-write must be queued');
  assert.ok(
    runAt < helper.indexOf('readCreatedIdsStrict()') &&
      runAt < helper.indexOf('writeCreatedIds('),
    'both the read and the write must sit INSIDE the queued job'
  );
  // And the read must be the strict one: the lenient reader turns a failed
  // read into [], which this helper would then write back over a key shared by
  // every account on the handset.
  assert.doesNotMatch(helper, /await readCreatedIds\(\)/, 'the writer must not use the lenient reader');
  assert.match(helper, /if \(current === null\) throw/, 'an unreadable row must be refused, not overwritten');
  // writeCreatedIds is the unqueued primitive: only the helper may call it.
  //
  // Stated as the property. This used to count `await writeCreatedIds(` and
  // require ZERO — a proxy that held only while the helper happened to call it
  // without `await`. Adding the await turned it red against correct code:
  // ninth assertion tonight pinning a shape rather than the rule.
  const outside = tutorial2
    .replace(/async function writeCreatedIds[\s\S]*?\n}/, '')
    .replace(/async function mutateCreatedIds[\s\S]*?\n}/, '');
  assert.doesNotMatch(
    outside,
    /writeCreatedIds\(/,
    'every write must go through mutateCreatedIds, or the queue is bypassed'
  );
  // The network delete loop must NOT hold the queue — serialQueue has no
  // reentrancy guard and the sweep is fired unawaited at app start, so a
  // deadlock there hangs silently.
  const sweepBody = tutorial2.match(/export async function sweepTutorialRounds[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(
    sweepBody.indexOf('await deleteRound(') < sweepBody.indexOf('await mutateCreatedIds('),
    'the queued tail must come after the network loop, never wrap it'
  );
  assert.doesNotMatch(
    sweepBody,
    /registryQueue\.run\([\s\S]*await deleteRound\(/,
    'the network delete must never run inside the queue'
  );
  // The previous string[] shape has no known owner; keep it, never sweep it.
  assert.match(tutorial, /typeof v === 'string'\) return \[\{ id: v, userId: null \}\]/);
});

// The device-wide active-round key carries no owner, so it must not be a
// candidate — an id that reached it without reaching the registry cannot be
// attributed to anyone.
test('the unattributable active-round key is not a sweep candidate', () => {
  assert.doesNotMatch(sweep, /candidates\.add\(active\)/);
});

// app/_layout only sweeps when the active key is EMPTY, so an account that
// signs out mid-tutorial would leave it set and disable tutorial cleanup for
// every account afterwards.
test('sign-out clears the active-round key', () => {
  const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
  assert.match(storage, /\['tutorial\.active_round'\]/);
  const layout = readFileSync(join(root, 'app/_layout.tsx'), 'utf8');
  assert.match(
    layout,
    /if \(!active\) void sweepTutorialRounds\(\)/,
    'this is the gate that makes a stuck active key matter'
  );
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
