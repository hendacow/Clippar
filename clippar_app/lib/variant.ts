/**
 * variant.ts — which build am I? (node-safe)
 *
 * `variantIsDev()` returns true ONLY in the development (clippar-dev) build.
 * Staging, production, and any unknown/absent variant return false, so prod
 * stays byte-identical.
 *
 * Why node-safe matters: constants/config.ts calls this at module load, and
 * config.ts is imported by lib/tracerMath.ts and scripts/simulate-tracer.ts,
 * which run under plain node (via tsx) in tests and CI — with no React Native
 * runtime. A bare `import Constants from 'expo-constants'` that touched native
 * state at load could crash those scripts. So we resolve the variant with a
 * try/catch `require` and fall back to `process.env.APP_VARIANT`, guaranteeing
 * the require of config.ts never throws under node.
 */

/**
 * True only for the development variant (clippar-dev). Safe to call from any
 * context — React Native runtime, plain node scripts, or unit tests.
 */
export function variantIsDev(): boolean {
  // 1) React Native runtime: the build baked extra.variant from APP_VARIANT
  //    (see app.config.js → expo.extra.variant). Lazy `require` so this file
  //    carries no static native dependency; if expo-constants is unavailable
  //    or throws (plain node), we swallow it and fall through to env.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-constants');
    const Constants = mod?.default ?? mod;
    const variant = Constants?.expoConfig?.extra?.variant;
    if (typeof variant === 'string') {
      return variant === 'development';
    }
  } catch {
    // expo-constants not resolvable under plain node / tsx — use env below.
  }

  // 2) Plain node / tooling: honor APP_VARIANT if a script or CI set it.
  //    (In the RN runtime this branch is only reached if expo-constants gave
  //    no variant string, in which case defaulting to non-dev is prod-safe.)
  try {
    return (
      typeof process !== 'undefined' &&
      process?.env?.APP_VARIANT === 'development'
    );
  } catch {
    return false;
  }
}
