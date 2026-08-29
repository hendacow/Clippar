/**
 * Server-authoritative hardware pricing.
 *
 * The client sends a product_type, never a price. Anything the client claims the
 * amount should be is ignored — otherwise a modified app (or a plain curl with a
 * valid JWT) could buy a kit for a cent.
 *
 * Keep in sync with clippar_app/constants/config.ts → config.hardware.
 * Changing a price here requires redeploying this function:
 *   supabase functions deploy create-payment-intent --project-ref <ref>
 */

export const CURRENCY = 'aud';

export const PRICE_TABLE_AUD_CENTS = {
  standard: 9900,
  premium: 10900,
} as const;

export type ProductType = keyof typeof PRICE_TABLE_AUD_CENTS;

export function isProductType(value: unknown): value is ProductType {
  // Object.hasOwn, not `in` — `in` walks the prototype chain, so 'toString'
  // and 'constructor' would otherwise resolve as valid products.
  return typeof value === 'string' && Object.hasOwn(PRICE_TABLE_AUD_CENTS, value);
}

/**
 * Resolve the amount to charge, in the smallest currency unit.
 * Throws on anything not in the table so an unknown product can never fall
 * through to a default or to a client-supplied number.
 */
export function resolvePriceCents(productType: unknown): number {
  if (!isProductType(productType)) {
    throw new Error(
      `Unknown product_type: ${JSON.stringify(productType)}. ` +
        `Expected one of: ${Object.keys(PRICE_TABLE_AUD_CENTS).join(', ')}`
    );
  }
  return PRICE_TABLE_AUD_CENTS[productType];
}
