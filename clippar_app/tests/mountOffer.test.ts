import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreshAccount,
  shouldShowMountOffer,
  FRESH_ACCOUNT_WINDOW_MS,
} from '../lib/mountOfferLogic';

// The post-signup mount offer must appear exactly once for NEW accounts and
// never for returning logins. These tests lock down the decision function so
// the two signals (email-signup pending flag, account-age freshness) and the
// seen override can't silently regress.

const NOW = Date.parse('2026-07-23T10:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test('social signup seconds ago → show', () => {
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: false, createdAt: iso(10_000), nowMs: NOW }),
    true
  );
});

test('returning login of an old account → never show', () => {
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: false, createdAt: iso(yearMs), nowMs: NOW }),
    false
  );
});

test('email signup: pending flag shows even when confirmation took > 48h', () => {
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: true, createdAt: iso(fiveDaysMs), nowMs: NOW }),
    true
  );
});

test('seen wins over everything — at most once, ever', () => {
  assert.equal(
    shouldShowMountOffer({ seen: true, pending: true, createdAt: iso(1_000), nowMs: NOW }),
    false
  );
});

test('missing or malformed created_at without pending → no show', () => {
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: false, createdAt: null, nowMs: NOW }),
    false
  );
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: false, createdAt: undefined, nowMs: NOW }),
    false
  );
  assert.equal(
    shouldShowMountOffer({ seen: false, pending: false, createdAt: 'not-a-date', nowMs: NOW }),
    false
  );
});

test('freshness window boundaries', () => {
  // Just inside the window.
  assert.equal(isFreshAccount(iso(FRESH_ACCOUNT_WINDOW_MS - 1_000), NOW), true);
  // Just outside the window.
  assert.equal(isFreshAccount(iso(FRESH_ACCOUNT_WINDOW_MS + 1_000), NOW), false);
});

test('small clock skew (server created_at slightly in the future) still fresh', () => {
  // 30s "in the future" relative to device clock.
  assert.equal(isFreshAccount(iso(-30_000), NOW), true);
  // An hour in the future is not plausible skew — reject.
  assert.equal(isFreshAccount(iso(-60 * 60 * 1000), NOW), false);
});
