/**
 * Tests for the create-payment-intent product allowlist.
 *
 *   deno test supabase/functions/create-payment-intent/pricing.test.ts
 *
 * The attack these lock down: the price table used to be a plain object
 * literal, and the "unknown product" guard was `table[key] === undefined`.
 * Object literals inherit Object.prototype, so `constructor`, `toString`,
 * `valueOf` and `__proto__` all resolved to something non-undefined and slipped
 * past a check whose whole job was to reject anything not in the catalog. No
 * price manipulation was reachable (the inherited values are functions, not
 * numbers) but it was a genuine allowlist bypass, and the value it produced went
 * on to `stripe.paymentIntents.create({ amount })`.
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { PRICE_CURRENCY, resolvePriceCents, resolveProductType } from './pricing.ts';
import { config } from '../../../constants/config.ts';

Deno.test('catalog products resolve to their server-side price', () => {
  assertEquals(resolvePriceCents('standard'), 9900);
  assertEquals(resolvePriceCents('premium'), 10900);
});

Deno.test('a missing product_type defaults to standard, not to a bypass', () => {
  assertEquals(resolvePriceCents(undefined), 9900);
  assertEquals(resolvePriceCents(null), 9900);
  assertEquals(resolvePriceCents(42), 9900);
  assertEquals(resolveProductType(undefined), 'standard');
});

// The table here is what the customer is CHARGED; constants/config.ts is what
// the app DISPLAYS. They are separate files by necessity (Deno vs the RN
// bundle), so nothing but this test stops one being raised without the other —
// which is exactly how a "$99" kit could go on billing $59.
Deno.test('charged price matches the price the app displays', () => {
  assertEquals(
    resolvePriceCents('standard'),
    config.hardware.standardPriceCents,
    'standard kit: pricing.ts and constants/config.ts disagree',
  );
  assertEquals(
    resolvePriceCents('premium'),
    config.hardware.premiumPriceCents,
    'premium kit: pricing.ts and constants/config.ts disagree',
  );
  assertEquals(PRICE_CURRENCY, config.hardware.currency);
});

// THE REGRESSION. Every one of these returned a non-undefined value under the
// old bare-lookup guard.
Deno.test('inherited Object.prototype keys are rejected, not priced', () => {
  for (
    const key of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__',
      '__defineGetter__',
      '__lookupGetter__',
    ]
  ) {
    assertEquals(
      resolvePriceCents(key),
      null,
      `"${key}" must not resolve to a price`,
    );
  }
});

Deno.test('unknown products are rejected', () => {
  assertEquals(resolvePriceCents('free'), null);
  assertEquals(resolvePriceCents('STANDARD'), null); // case-sensitive allowlist
  assertEquals(resolvePriceCents(''), null);
});
