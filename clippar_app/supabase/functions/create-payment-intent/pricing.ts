/**
 * The product catalog and the price lookup, kept in their own module so they can
 * be unit-tested without constructing the Stripe or Supabase clients that
 * index.ts builds at import time.
 *
 * Server-authoritative price table. The amount charged is derived here from a
 * fixed catalog, NEVER from the client body — a client-supplied amount let any
 * authenticated user pay 1 cent for a physical kit. Prices (in cents) mirror
 * constants/config.ts (standardPriceCents / premiumPriceCents) and the currency
 * is fixed. Update both together when pricing changes.
 *
 * Declared with a null prototype so the table has NO inherited keys. As a plain
 * object literal it inherited Object.prototype, and the caller's allowlist test
 * was `table[key] === undefined` — so `{"product_type":"constructor"}`,
 * `"toString"` and `"__proto__"` all resolved to something non-undefined, walked
 * past the "unknown product" rejection, and handed Stripe a function where an
 * integer was expected.
 */
const PRICE_TABLE_AUD_CENTS: Record<string, number> = Object.assign(
  Object.create(null) as Record<string, number>,
  {
    standard: 5900,
    premium: 6900,
  },
);

export const PRICE_CURRENCY = 'aud';

/**
 * Resolve a client-supplied product type to a server-owned price, or null when
 * the product is not in the catalog.
 *
 * `hasOwnProperty` is what makes this an ALLOWLIST rather than "any key that
 * happens to resolve to something". Belt and braces with the null-prototype
 * table above — either one alone closes the bypass, but the next person to
 * simplify the table back to an object literal must not silently reopen it.
 * The integer/positive check is the last line: whatever comes back must be
 * something Stripe can charge.
 */
export function resolvePriceCents(productType: unknown): number | null {
  const key = resolveProductType(productType);
  if (!Object.prototype.hasOwnProperty.call(PRICE_TABLE_AUD_CENTS, key)) return null;
  const amount = PRICE_TABLE_AUD_CENTS[key];
  return typeof amount === 'number' && Number.isInteger(amount) && amount > 0
    ? amount
    : null;
}

/** Normalised product label that goes into Stripe metadata. */
export function resolveProductType(productType: unknown): string {
  return typeof productType === 'string' ? productType : 'standard';
}
