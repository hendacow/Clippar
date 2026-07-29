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
import { resolvePriceCents, resolveProductType } from './pricing.ts';

Deno.test('catalog products resolve to their server-side price', () => {
  assertEquals(resolvePriceCents('standard'), 5900);
  assertEquals(resolvePriceCents('premium'), 6900);
});

Deno.test('a missing product_type defaults to standard, not to a bypass', () => {
  assertEquals(resolvePriceCents(undefined), 5900);
  assertEquals(resolvePriceCents(null), 5900);
  assertEquals(resolvePriceCents(42), 5900);
  assertEquals(resolveProductType(undefined), 'standard');
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
