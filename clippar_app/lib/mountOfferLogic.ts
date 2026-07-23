/**
 * Pure decision logic for the one-time post-signup Clippar Mount offer
 * (feat/mount-upsell). Deliberately storage-free and import-free so the node
 * test runner can exercise it directly (tests/mountOffer.test.ts) — the
 * SQLite-backed glue lives in lib/mountOffer.ts.
 */

/**
 * Accounts created within this window count as "brand new" when the user
 * lands signed-in from an auth screen. Covers social-auth signups (account
 * created seconds before the session lands) with generous headroom, without
 * ever matching a genuinely old account signing in on a new device.
 */
export const FRESH_ACCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Small tolerance for device-vs-server clock skew: a server-side created_at
 *  a few seconds "in the future" must still count as fresh. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function isFreshAccount(
  createdAt: string | null | undefined,
  nowMs: number
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  const ageMs = nowMs - created;
  return ageMs >= -CLOCK_SKEW_TOLERANCE_MS && ageMs <= FRESH_ACCOUNT_WINDOW_MS;
}

/**
 * Should the post-signup mount offer screen be shown right now?
 *  - `seen` wins over everything: the offer appears at most once, ever.
 *  - `pending` is the local marker written the moment an EMAIL signup
 *    succeeds on this device — it makes the first post-confirmation login
 *    show the offer no matter how long the email round-trip took.
 *  - account freshness catches social-auth signups, which create the account
 *    and the session in a single step with no chance to set a local marker.
 * Returning logins of existing accounts match neither signal.
 */
export function shouldShowMountOffer(args: {
  seen: boolean;
  pending: boolean;
  createdAt: string | null | undefined;
  nowMs: number;
}): boolean {
  if (args.seen) return false;
  return args.pending || isFreshAccount(args.createdAt, args.nowMs);
}
