/**
 * Ownership rules for the on-device SQLite store (`clippar.db`).
 *
 * There is ONE database file per handset and every account that ever signs in
 * shares it. Sign-out deliberately does NOT wipe it: this app holds a golfer's
 * only copy of their footage, so a wipe bolted onto sign-out would destroy a
 * round that physically cannot be re-recorded. Scoping is the control instead
 * — rows carry the id of the user who created them, and the reads that decide
 * what a session is *offered* go through here.
 *
 * The attack this closes: user A leaves a round `in_progress` (the normal state
 * until "End Round"), signs out, hands the phone over. User B signs in, and the
 * record tab's `getOrphanedRounds()` used to be a bare
 * `SELECT * FROM local_rounds WHERE status = 'in_progress'` — so B was shown an
 * "Unfinished round at <A's course>" card whose Resume button hydrated A's
 * scores and A's raw swing videos into B's session, where they could be played,
 * trimmed, saved to B's Photos and shared, then written to Supabase under B's
 * user id. The same unscoped read let A's queued clips upload into B's account.
 *
 * Pure by design (no react-native / expo imports) so the rules are unit
 * testable — see tests/localScope.test.ts.
 */

/** The signed-in user, or null when no session could be resolved. */
export type SessionUserId = string | null | undefined;

export interface ScopeClause {
  /** SQL fragment to AND into a WHERE clause. */
  sql: string;
  /** Positional params the fragment consumes, in order. */
  params: string[];
}

/**
 * Restrict a `local_rounds` read to rows owned by the signed-in user.
 *
 * Fails CLOSED: with no resolvable session we emit `0 = 1` rather than no
 * predicate at all, because "nobody is signed in" must offer nothing, not
 * everything. A dropped/blank predicate here is the whole vulnerability, so
 * there is deliberately no code path that returns an empty clause.
 */
export function ownedRoundsClause(sessionUserId: SessionUserId): ScopeClause {
  if (!sessionUserId) return { sql: '0 = 1', params: [] };
  return { sql: 'user_id = ?', params: [sessionUserId] };
}

/**
 * Belt-and-braces post-filter for rows that came back from a scoped query.
 * Cheap, and it means a future refactor that loosens the SQL (or a legacy row
 * the one-time backfill hasn't claimed yet) still can't hand account B a round
 * stamped to account A.
 */
export function isRowVisible(
  rowUserId: string | null | undefined,
  sessionUserId: SessionUserId
): boolean {
  if (!sessionUserId) return false;
  return rowUserId === sessionUserId;
}

/**
 * Whether to claim rows written before the `user_id` column existed.
 *
 * Those rows read back as NULL and, left alone, would be invisible to their
 * own owner after the update — silently hiding an in-progress round from the
 * golfer who recorded it. So the first signed-in user of each app launch
 * stamps them, once. That is the same exposure the data already had before
 * this migration (it was unscoped for everyone), and the alternative —
 * orphaning a real round forever — is worse. Everything written after the
 * migration is stamped at insert time and is never claimable.
 *
 * **This paragraph is the mechanism of an open finding, and it is on `main`.**
 * It predates the review that flagged it. It is left in place deliberately: it
 * is the only written explanation of why this trade-off was made, sitting on
 * the function that makes it, and a maintainer who removes the reasoning is
 * more likely to break the behaviour than one who reads it. Removing it is a
 * change to shipped code that this review does not own, so it is Henry's call
 * rather than a fix — see the private tracker.
 *
 * What the marker below DOES buy is that no *further* copy of this reasoning
 * can be added anywhere else in the tree. The guard exempts this file by
 * construction, so it constrains the copies, not the original. That limit is
 * the point of writing it down.
 *
 * @guarded 23 */
export function shouldClaimLegacyRows(
  sessionUserId: SessionUserId,
  alreadyClaimed: boolean
): boolean {
  return !!sessionUserId && !alreadyClaimed;
}
