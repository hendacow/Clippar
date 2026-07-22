/**
 * Dev-only paywall bypass ("Dev: unlock Pro").
 *
 * WHY: the dev build ("Clippar Dev", com.clippar.app.dev) has no App Store
 * products, so a real purchase can never succeed there — without this the
 * founder is locked behind his own paywall in every dev build.
 *
 * FAIL-CLOSED GATING (same philosophy as config.tracer.enabled):
 *  - The ONLY thing that can enable the override is the app.config.js
 *    `extra.variant === 'development'` check — the exact variant switch that
 *    names the binary "Clippar Dev". Staging, production, or a missing/unknown
 *    variant all read as NOT dev, so the bypass is structurally impossible in
 *    any App Store binary.
 *  - Outside the dev variant we never even READ the persisted flag: every
 *    entry point returns false before touching storage.
 *  - The flag itself defaults to absent (= false) and lives only in the local
 *    SQLite settings table — it is never synced, never sent to a server.
 *
 * Toggle UX: the paywall's "Dev: unlock Pro" action toggles it (tap again to
 * relock). There is no dedicated dev-settings screen, so the paywall action is
 * both the setter and the unsetter.
 */
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { getSetting, setSetting } from '@/lib/storage';
import { variantIsDev } from '@/lib/proStatusLogic';

const DEV_PRO_OVERRIDE_KEY = 'dev.pro_override';

/** app.config.js `extra.variant` for this binary (undefined if absent). */
export function currentVariant(): string | undefined {
  return Constants.expoConfig?.extra?.variant as string | undefined;
}

/**
 * True only in the development variant (Clippar Dev). Fail-closed, and
 * DOUBLE-gated against the OTA foot-gun:
 *
 * `extra.variant` is evaluated at PUBLISH time, so a local
 * `APP_VARIANT=development eas update --branch production` would push a
 * dev-variant manifest into every App Store install. The manifest check
 * alone would then light up "Dev: unlock Pro" for real users. The native
 * bundle identifier, however, is baked into the binary and can never be
 * changed by an OTA update — so we additionally require it to be the
 * `.dev` bundle (com.clippar.app.dev). A production binary that receives
 * a dev-variant manifest still reads NOT dev.
 *
 * `Application.applicationId` is null only where the native module is
 * absent (web / a stale dev client built before expo-application was a
 * direct dep) — in that case we fall back to the manifest check alone,
 * which is the pre-hardening behaviour and only reachable in non-store
 * contexts.
 */
export function isDevVariant(): boolean {
  if (!variantIsDev(currentVariant())) return false;
  const bundleId = Application.applicationId;
  if (bundleId != null && !bundleId.endsWith('.dev')) return false;
  return true;
}

/**
 * Persisted dev override. Returns false — WITHOUT reading storage — whenever
 * the running binary is not the dev variant.
 */
export async function getDevProOverride(): Promise<boolean> {
  if (!isDevVariant()) return false;
  try {
    return (await getSetting(DEV_PRO_OVERRIDE_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * Flip the override (dev variant only; no-op false elsewhere).
 * Returns the new value.
 */
export async function toggleDevProOverride(): Promise<boolean> {
  if (!isDevVariant()) return false;
  const next = !(await getDevProOverride());
  // Clearing stores NULL (removes the row) rather than '0' so a relocked
  // device is indistinguishable from one that never used the override.
  await setSetting(DEV_PRO_OVERRIDE_KEY, next ? '1' : null);
  return next;
}
