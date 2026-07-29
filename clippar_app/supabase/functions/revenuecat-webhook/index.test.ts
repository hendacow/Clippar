/**
 * Tests for the RevenueCat entitlement projection.
 *
 *   SUPABASE_URL=https://test.supabase.co SUPABASE_SERVICE_ROLE_KEY=test-key \
 *     deno test --allow-env supabase/functions/revenuecat-webhook/index.test.ts
 *
 * This is the code that decides who has Pro. Both directions cost real money:
 * over-granting gives the product away, and over-revoking takes Pro off someone
 * who paid for it — which is worse, because they notice.
 *
 * The TRANSFER cases are the point of this file. TRANSFER used to be
 * ack-and-skipped, on the reasoning that the payload has no reliable per-user
 * expiry so acting on it risked wrongly revoking a payer. The consequence was
 * that one purchase could be walked across unlimited Clippar accounts and every
 * one of them kept Pro forever, because nothing ever took it back off the old
 * identity.
 */
import {
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveUpdates, type DeriveConfig, type RcEvent } from './index.ts';

const NOW = Date.parse('2026-07-29T00:00:00.000Z');
const FUTURE = NOW + 30 * 86_400_000;
const PAST = NOW - 30 * 86_400_000;

const U_A = '11111111-1111-4111-8111-111111111111';
const U_B = '22222222-2222-4222-8222-222222222222';

const CFG: DeriveConfig = {
  lifetimeProductIds: new Set(['clippar_pro_lifetime']),
  allowSandbox: false,
};

function ev(e: Partial<RcEvent>): RcEvent {
  return { type: 'INITIAL_PURCHASE', ...e } as RcEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('SANDBOX events are ignored in production', () => {
  // TestFlight and StoreKit-sandbox purchases cost nothing and arrive at the
  // same production webhook. Acting on them is free Pro on real profiles.
  const out = deriveUpdates(
    ev({ environment: 'SANDBOX', expiration_at_ms: FUTURE }), NOW, U_A, CFG);
  assertEquals(out, []);
});

Deno.test('SANDBOX events are honoured when explicitly allowed', () => {
  const out = deriveUpdates(
    ev({ environment: 'SANDBOX', expiration_at_ms: FUTURE }), NOW, U_A,
    { ...CFG, allowSandbox: true });
  assertEquals(out.length, 1);
  assertEquals(out[0].status, 'active');
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER — the account-sharing hole
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('TRANSFER revokes the identity the entitlement moved OFF', () => {
  // Without this, buy Pro once, sign into a second Clippar account, and both
  // accounts keep Pro. Repeat indefinitely.
  const out = deriveUpdates(
    ev({ type: 'TRANSFER', transferred_from: [U_A], transferred_to: [U_B],
         expiration_at_ms: FUTURE }), NOW, null, CFG);
  const revoked = out.find((u) => u.userId === U_A);
  assertEquals(revoked?.status, 'expired');
  assertEquals(revoked?.expires_at, new Date(NOW).toISOString());
});

Deno.test('TRANSFER grants the identity it moved ONTO', () => {
  const out = deriveUpdates(
    ev({ type: 'TRANSFER', transferred_from: [U_A], transferred_to: [U_B],
         expiration_at_ms: FUTURE }), NOW, null, CFG);
  const granted = out.find((u) => u.userId === U_B);
  assertEquals(granted?.status, 'active');
  assertEquals(granted?.expires_at, new Date(FUTURE).toISOString());
});

Deno.test('TRANSFER does NOT revoke an identity that is both source and target', () => {
  // An alias merge lists the same id on both sides. Revoking it would strip Pro
  // from someone who still holds the entitlement — the exact over-revocation
  // the original ack-and-skip was trying to avoid.
  const out = deriveUpdates(
    ev({ type: 'TRANSFER', transferred_from: [U_A, U_B], transferred_to: [U_A],
         expiration_at_ms: FUTURE }), NOW, null, CFG);
  assertEquals(out.filter((u) => u.userId === U_A && u.status === 'expired').length, 0);
  assertEquals(out.find((u) => u.userId === U_B)?.status, 'expired');
});

Deno.test('TRANSFER with an already-expired window revokes but does not grant', () => {
  // A finite subscription that has already lapsed must not be resurrected on
  // the target account.
  const out = deriveUpdates(
    ev({ type: 'TRANSFER', transferred_from: [U_A], transferred_to: [U_B],
         expiration_at_ms: PAST }), NOW, null, CFG);
  assertEquals(out.length, 1);
  assertEquals(out[0].userId, U_A);
  assertEquals(out[0].status, 'expired');
});

Deno.test('TRANSFER with a null expiry does not grant perpetual access', () => {
  // A missing expiry written straight through would read downstream as
  // lifetime Pro.
  const out = deriveUpdates(
    ev({ type: 'TRANSFER', transferred_from: [U_A], transferred_to: [U_B],
         expiration_at_ms: null }), NOW, null, CFG);
  assertEquals(out.some((u) => u.userId === U_B), false);
});

Deno.test('TRANSFER ignores ids that are not UUIDs', () => {
  // RevenueCat app_user_ids are only Supabase uuids when our own identify()
  // set them; anonymous RC ids ($RCAnonymousID:...) must never reach a
  // profiles.id predicate.
  const out = deriveUpdates(
    ev({ type: 'TRANSFER',
         transferred_from: ['$RCAnonymousID:abc123', U_A],
         transferred_to: ['not-a-uuid'],
         expiration_at_ms: FUTURE }), NOW, null, CFG);
  assertEquals(out.length, 1);
  assertEquals(out[0].userId, U_A);
});

// ─────────────────────────────────────────────────────────────────────────────
// Refunds vs cancellations — opposite meanings, similar payloads
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('REFUND ends access immediately, not at period end', () => {
  const out = deriveUpdates(
    ev({ type: 'REFUND', expiration_at_ms: FUTURE }), NOW, U_A, CFG);
  assertEquals(out[0].status, 'expired');
  assertEquals(out[0].expires_at, new Date(NOW).toISOString());
});

Deno.test('a CANCELLATION carrying a refund reason ends access immediately', () => {
  // Apple reports a refund as a CANCELLATION with a reason, not its own type.
  // Treating it as an ordinary cancellation leaves a refunded subscriber active
  // for the whole period they were paid back for — every renewal, for free.
  for (const reason of ['CUSTOMER_SUPPORT', 'UNKNOWN']) {
    const out = deriveUpdates(
      ev({ type: 'CANCELLATION', cancel_reason: reason, expiration_at_ms: FUTURE }),
      NOW, U_A, CFG);
    assertEquals(out[0].status, 'expired', `reason ${reason}`);
    assertEquals(out[0].expires_at, new Date(NOW).toISOString(), `reason ${reason}`);
  }
});

Deno.test('an ordinary CANCELLATION keeps access until the paid period ends', () => {
  // CANCELLATION normally means auto-renew was switched off. The user paid for
  // this period and must keep it — revoking here would be taking away time
  // someone bought.
  const out = deriveUpdates(
    ev({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: FUTURE }),
    NOW, U_A, CFG);
  assertEquals(out[0].status, 'active');
  assertEquals(out[0].expires_at, new Date(FUTURE).toISOString());
});

Deno.test('BILLING_ERROR cancellation keeps access through the grace period', () => {
  const out = deriveUpdates(
    ev({ type: 'CANCELLATION', cancel_reason: 'BILLING_ERROR', expiration_at_ms: FUTURE }),
    NOW, U_A, CFG);
  assertEquals(out[0].status, 'active');
});

// ─────────────────────────────────────────────────────────────────────────────
// Perpetual access is opt-in only
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a null expiry on an unknown product writes NOTHING', () => {
  // A null expiry reads downstream as "never expires". Only a genuine
  // non-consumable may claim that; a malformed payload must not.
  const out = deriveUpdates(
    ev({ type: 'INITIAL_PURCHASE', product_id: 'clippar_pro_monthly',
         expiration_at_ms: null }), NOW, U_A, CFG);
  assertEquals(out, []);
});

Deno.test('a null expiry with no product_id at all writes NOTHING', () => {
  const out = deriveUpdates(
    ev({ type: 'INITIAL_PURCHASE', expiration_at_ms: null }), NOW, U_A, CFG);
  assertEquals(out, []);
});

Deno.test('a declared lifetime product may have a null expiry', () => {
  const out = deriveUpdates(
    ev({ type: 'INITIAL_PURCHASE', product_id: 'clippar_pro_lifetime',
         expiration_at_ms: null }), NOW, U_A, CFG);
  assertEquals(out[0].status, 'active');
  assertEquals(out[0].expires_at, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordinary lifecycle
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('EXPIRATION is terminal', () => {
  const out = deriveUpdates(
    ev({ type: 'EXPIRATION', expiration_at_ms: PAST }), NOW, U_A, CFG);
  assertEquals(out[0].status, 'expired');
});

Deno.test('a stale event whose window already closed lands as expired', () => {
  // Out-of-order delivery: a RENEWAL for a period that has since elapsed must
  // not re-grant access.
  const out = deriveUpdates(
    ev({ type: 'RENEWAL', expiration_at_ms: PAST }), NOW, U_A, CFG);
  assertEquals(out[0].status, 'expired');
});

Deno.test('a trial is recorded as trial, not active', () => {
  const out = deriveUpdates(
    ev({ type: 'INITIAL_PURCHASE', period_type: 'TRIAL', expiration_at_ms: FUTURE }),
    NOW, U_A, CFG);
  assertEquals(out[0].status, 'trial');
});

Deno.test('a renewal grants through to the new expiry', () => {
  const out = deriveUpdates(
    ev({ type: 'RENEWAL', expiration_at_ms: FUTURE }), NOW, U_A, CFG);
  assertEquals(out[0].status, 'active');
  assertEquals(out[0].expires_at, new Date(FUTURE).toISOString());
});

Deno.test('no resolvable user means no write', () => {
  // Better to drop the event than to write an entitlement onto the wrong row.
  const out = deriveUpdates(
    ev({ type: 'RENEWAL', expiration_at_ms: FUTURE }), NOW, null, CFG);
  assertEquals(out, []);
});

Deno.test('TEST and SUBSCRIBER_ALIAS carry no entitlement change', () => {
  assertEquals(deriveUpdates(ev({ type: 'TEST' }), NOW, U_A, CFG), []);
  assertEquals(deriveUpdates(ev({ type: 'SUBSCRIBER_ALIAS' }), NOW, U_A, CFG), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('the same event derived twice yields the same result', () => {
  // Webhooks retry. Every event re-derives full state from the event itself, so
  // duplicate delivery must converge rather than accumulate.
  const e = ev({ type: 'RENEWAL', expiration_at_ms: FUTURE });
  assertEquals(deriveUpdates(e, NOW, U_A, CFG), deriveUpdates(e, NOW, U_A, CFG));
});
