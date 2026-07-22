/**
 * Pure Pro-status precedence logic — NO imports, NO native modules — so the
 * fail-closed rules are unit-testable under `node --test` (tests/proStatus.test.ts).
 *
 * Precedence:
 *   1. A live store/backend entitlement ALWAYS wins → Pro.
 *   2. Otherwise the dev paywall bypass grants Pro ONLY when BOTH:
 *      - the running binary is the development variant (extra.variant ===
 *        'development', i.e. "Clippar Dev" / com.clippar.app.dev), AND
 *      - the persisted dev override flag is set.
 *
 * FAIL-CLOSED: any missing / unknown / production variant value means the
 * override is inert. `lib/devPro.ts` additionally refuses to even READ the
 * persisted flag outside the dev variant, so this function's `devOverride`
 * input is already false in production — this check is defense in depth.
 */

export type AppVariant = string | null | undefined;

/** True ONLY for the explicit 'development' variant. Unknown → false. */
export function variantIsDev(variant: AppVariant): boolean {
  return variant === 'development';
}

export interface ProStatusInputs {
  /** Live entitlement truth (RevenueCat "Clippar Pro" or Supabase profile). */
  entitlementActive: boolean;
  /** app.config.js `extra.variant` as reported by expo-constants. */
  variant: AppVariant;
  /** Persisted dev-only override flag (false when unread/absent). */
  devOverride: boolean;
}

export function resolveProStatus(inputs: ProStatusInputs): boolean {
  if (inputs.entitlementActive) return true;
  return variantIsDev(inputs.variant) && inputs.devOverride === true;
}
