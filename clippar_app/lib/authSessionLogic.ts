/**
 * Auth session recovery logic.
 *
 * On cold start `supabase.auth.getSession()` will try to refresh a stored
 * session. When the persisted refresh token is stale (rotated, expired, or a
 * leftover from an older storage format) GoTrue's `_recoverAndRefresh` rejects
 * with an AuthApiError like:
 *
 *   "AuthApiError: Invalid Refresh Token: Refresh Token Not Found"
 *
 * Left uncaught this surfaces as a red LogBox error on the user's device. The
 * correct behaviour is to treat that specific case as "not signed in": clear
 * the bad token and land on the login screen with no error shown.
 *
 * CRITICAL: this must fire ONLY for the genuinely-invalid-token case. A valid
 * session, a network blip, or any other error must NOT trigger a sign-out.
 * This pure classifier keeps that boundary explicit and unit-testable.
 */

/**
 * True only when `err` is the stale/missing refresh-token error that means the
 * stored session can never be recovered and should be cleared.
 *
 * Matches on GoTrue's stable error `code` first, then falls back to the human
 * message text. Deliberately narrow: unrelated auth errors, network failures,
 * and non-errors all return false so a valid session is never cleared.
 */
export function isInvalidRefreshTokenError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  // GoTrue attaches a stable machine code on AuthApiError for this case.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    const c = code.toLowerCase();
    if (c === 'refresh_token_not_found' || c === 'refresh_token_already_used') {
      return true;
    }
  }

  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  const m = message.toLowerCase();

  // "Invalid Refresh Token: Refresh Token Not Found" and its variants. Require
  // the phrase to mention the refresh token specifically so a generic "invalid"
  // or "not found" from an unrelated call can't match.
  if (m.includes('refresh token')) {
    return (
      m.includes('not found') ||
      m.includes('invalid') ||
      m.includes('already used') ||
      m.includes('expired')
    );
  }

  return false;
}
