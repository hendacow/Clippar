import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInvalidRefreshTokenError } from '../lib/authSessionLogic';

// The cold-start session recovery must clear the stored session ONLY for the
// genuinely-stale refresh-token error. These tests lock that boundary so the
// handler can never sign out a user holding a valid session.

test('the reported device error message → true', () => {
  const err = new Error('Invalid Refresh Token: Refresh Token Not Found');
  assert.equal(isInvalidRefreshTokenError(err), true);
});

test('GoTrue AuthApiError-shaped object with code → true', () => {
  const err = { name: 'AuthApiError', code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 };
  assert.equal(isInvalidRefreshTokenError(err), true);
});

test('refresh_token_already_used code → true', () => {
  assert.equal(isInvalidRefreshTokenError({ code: 'refresh_token_already_used', message: 'x' }), true);
});

test('expired refresh token message → true', () => {
  assert.equal(isInvalidRefreshTokenError(new Error('Invalid Refresh Token: Token Expired')), true);
});

// ── Must NOT match: valid-session and unrelated cases ────────────────────────

test('null / undefined → false (no error, valid session)', () => {
  assert.equal(isInvalidRefreshTokenError(null), false);
  assert.equal(isInvalidRefreshTokenError(undefined), false);
});

test('wrong password error → false (must not sign out)', () => {
  const err = new Error('Invalid login credentials');
  assert.equal(isInvalidRefreshTokenError(err), false);
});

test('generic network failure → false (must not clear a valid session)', () => {
  assert.equal(isInvalidRefreshTokenError(new Error('Network request failed')), false);
});

test('unrelated "not found" (e.g. user not found) → false', () => {
  assert.equal(isInvalidRefreshTokenError(new Error('User not found')), false);
});

test('unrelated "invalid" (e.g. invalid email) → false', () => {
  assert.equal(isInvalidRefreshTokenError(new Error('Invalid email address')), false);
});

test('string (not an object) → false', () => {
  assert.equal(isInvalidRefreshTokenError('Invalid Refresh Token'), false);
});

test('object with non-string message → false', () => {
  assert.equal(isInvalidRefreshTokenError({ message: 12345 }), false);
});
