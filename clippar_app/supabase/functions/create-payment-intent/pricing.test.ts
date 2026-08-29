import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CURRENCY,
  PRICE_TABLE_AUD_CENTS,
  isProductType,
  resolvePriceCents,
} from './pricing.ts';

Deno.test('prices match constants/config.ts hardware block', () => {
  assertEquals(PRICE_TABLE_AUD_CENTS.standard, 9900);
  assertEquals(PRICE_TABLE_AUD_CENTS.premium, 10900);
  assertEquals(CURRENCY, 'aud');
});

Deno.test('resolves the known product types', () => {
  assertEquals(resolvePriceCents('standard'), 9900);
  assertEquals(resolvePriceCents('premium'), 10900);
});

Deno.test('rejects anything not in the table', () => {
  for (const bad of ['', 'STANDARD', 'free', 'standard ', null, undefined, 1, {}, []]) {
    assertThrows(() => resolvePriceCents(bad), Error, 'Unknown product_type');
  }
});

Deno.test('a client-supplied amount cannot influence the price', () => {
  // Simulates the old attack: body carried {amount: 1}. resolvePriceCents only
  // ever reads product_type, so the tampered amount is unreachable.
  const tamperedBody = { amount: 1, currency: 'aud', product_type: 'standard' };
  assertEquals(resolvePriceCents(tamperedBody.product_type), 9900);
});

Deno.test('isProductType does not treat inherited keys as products', () => {
  assertEquals(isProductType('toString'), false);
  assertEquals(isProductType('constructor'), false);
  assertEquals(isProductType('standard'), true);
});
