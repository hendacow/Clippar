import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProStatus, variantIsDev } from '../lib/proStatusLogic';

// Locks down the fail-closed precedence rules for Pro gating + the dev-only
// paywall bypass (lib/proStatusLogic.ts, consumed by lib/subscription.
// getProStatus). The invariant that must never regress: the dev override can
// NEVER grant Pro outside the explicit 'development' variant.

test('entitlement active → Pro, regardless of variant or override', () => {
  assert.equal(
    resolveProStatus({ entitlementActive: true, variant: 'production', devOverride: false }),
    true
  );
  assert.equal(
    resolveProStatus({ entitlementActive: true, variant: 'development', devOverride: false }),
    true
  );
  assert.equal(
    resolveProStatus({ entitlementActive: true, variant: undefined, devOverride: false }),
    true
  );
});

test('dev variant + override → Pro (the founder-unblock path)', () => {
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'development', devOverride: true }),
    true
  );
});

test('override in PRODUCTION → never Pro (fail-closed)', () => {
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'production', devOverride: true }),
    false
  );
});

test('override in staging / unknown / missing variant → never Pro', () => {
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'staging', devOverride: true }),
    false
  );
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: undefined, devOverride: true }),
    false
  );
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: null, devOverride: true }),
    false
  );
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'Development', devOverride: true }),
    false,
    'variant match must be exact — no case-insensitive loosening'
  );
});

test('no entitlement, no override → free', () => {
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'development', devOverride: false }),
    false
  );
  assert.equal(
    resolveProStatus({ entitlementActive: false, variant: 'production', devOverride: false }),
    false
  );
});

test('variantIsDev: only the exact development variant counts', () => {
  assert.equal(variantIsDev('development'), true);
  assert.equal(variantIsDev('staging'), false);
  assert.equal(variantIsDev('production'), false);
  assert.equal(variantIsDev(''), false);
  assert.equal(variantIsDev(undefined), false);
  assert.equal(variantIsDev(null), false);
});
