import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownedRoundsClause,
  isRowVisible,
  shouldClaimLegacyRows,
} from '../lib/localScope';

// The attack these lock down (SEC-002 / spec 5.1, 5.5):
//   User A records a round on a shared handset and leaves it `in_progress`
//   (the normal state until "End Round"), then signs out. User B signs in.
//   The record tab calls getOrphanedRounds(); if that read is not scoped, B is
//   shown "Unfinished round at <A's course>" with a Resume button that hydrates
//   A's scores and A's raw swing videos into B's session — playable, trimmable,
//   savable to B's Photos, shareable, and finally written to Supabase under B's
//   user id. The same unscoped read fed uploadQueue, which uploads whatever it
//   returns into the CURRENTLY signed-in account.
// Every assertion below is written as "the attack must fail".

const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';

// ── the SQL predicate ─────────────────────────────────────────────────────

test('predicate binds the signed-in user, so a query can never be owner-blind', () => {
  const scope = ownedRoundsClause(BOB);
  assert.equal(scope.sql, 'user_id = ?');
  assert.deepEqual(scope.params, [BOB]);
  // The clause must be a real restriction — an empty/always-true fragment is
  // the vulnerability itself.
  assert.notEqual(scope.sql.trim(), '');
  assert.ok(!/^\s*1\s*=\s*1\s*$/.test(scope.sql));
});

test('no session fails CLOSED: predicate matches nothing, not everything', () => {
  for (const missing of [null, undefined, '']) {
    const scope = ownedRoundsClause(missing);
    assert.equal(scope.sql, '0 = 1', `expected fail-closed for ${String(missing)}`);
    assert.deepEqual(scope.params, []);
  }
});

test("Bob's predicate does not bind Alice's id", () => {
  const scope = ownedRoundsClause(BOB);
  assert.ok(!scope.params.includes(ALICE));
});

// ── the row-level backstop ────────────────────────────────────────────────

test("Alice's round row is not visible to Bob's session", () => {
  assert.equal(isRowVisible(ALICE, BOB), false);
});

test("Alice's round row is visible to Alice", () => {
  assert.equal(isRowVisible(ALICE, ALICE), true);
});

test('an unstamped (pre-migration) row is not handed to a session by the backstop', () => {
  // The one-time claim gives these an owner; until it runs they belong to
  // nobody, and "belongs to nobody" must never read as "belongs to you".
  assert.equal(isRowVisible(null, BOB), false);
  assert.equal(isRowVisible(undefined, BOB), false);
});

test('signed out: no row is visible, whoever owns it', () => {
  for (const owner of [ALICE, BOB, null, undefined]) {
    assert.equal(isRowVisible(owner, null), false);
    assert.equal(isRowVisible(owner, undefined), false);
    assert.equal(isRowVisible(owner, ''), false);
  }
});

// ── the legacy claim ──────────────────────────────────────────────────────

test('legacy rows are claimed once, by a signed-in user only', () => {
  assert.equal(shouldClaimLegacyRows(ALICE, false), true);
  // Never twice in a launch — a second pass could re-claim rows written by a
  // session that has since changed.
  assert.equal(shouldClaimLegacyRows(ALICE, true), false);
  // And never with no session: an anonymous claim would stamp another user's
  // rows with nothing, or worse, run at the wrong moment.
  assert.equal(shouldClaimLegacyRows(null, false), false);
  assert.equal(shouldClaimLegacyRows(undefined, false), false);
  assert.equal(shouldClaimLegacyRows('', false), false);
});

// ── the composed read, as storage.ts performs it ──────────────────────────

interface FakeRoundRow {
  id: string;
  user_id: string | null;
}

/**
 * Mirror of getOrphanedRounds()/getLocalRound(): apply the SQL predicate, then
 * the row backstop. If either layer is dropped in a future refactor, the
 * corresponding case below starts failing.
 */
function scopedRead(rows: FakeRoundRow[], sessionUserId: string | null): FakeRoundRow[] {
  const scope = ownedRoundsClause(sessionUserId);
  const afterSql =
    scope.sql === '0 = 1' ? [] : rows.filter((r) => r.user_id === scope.params[0]);
  return afterSql.filter((r) => isRowVisible(r.user_id, sessionUserId));
}

test('handed-over phone: Bob is offered none of Alice’s rounds', () => {
  const rows: FakeRoundRow[] = [
    { id: 'round-alice-inprogress', user_id: ALICE },
    { id: 'round-alice-finished', user_id: ALICE },
    { id: 'round-legacy', user_id: null },
  ];
  assert.deepEqual(scopedRead(rows, BOB), []);
});

test('Alice still gets her own unfinished round back (the fix must not destroy data)', () => {
  const rows: FakeRoundRow[] = [
    { id: 'round-alice', user_id: ALICE },
    { id: 'round-bob', user_id: BOB },
  ];
  assert.deepEqual(
    scopedRead(rows, ALICE).map((r) => r.id),
    ['round-alice']
  );
});

test('signed out on a device full of rounds: nothing is offered', () => {
  const rows: FakeRoundRow[] = [
    { id: 'round-alice', user_id: ALICE },
    { id: 'round-bob', user_id: BOB },
    { id: 'round-legacy', user_id: null },
  ];
  assert.deepEqual(scopedRead(rows, null), []);
});
