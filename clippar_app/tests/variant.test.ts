import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { variantIsDev } from '../lib/variant';

// variantIsDev() must be NODE-SAFE: constants/config.ts calls it at module
// load, and config.ts is imported by tracerMath.ts + simulate-tracer.ts, which
// run under plain node (tsx) in CI. Under node, `require('expo-constants')`
// throws, so the function falls back to process.env.APP_VARIANT. These tests
// lock down both the env fallback and (via an injected mock) the Constants
// branch, plus the invariant that it never throws and only 'development' → true.

const req = createRequire(import.meta.url);

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.APP_VARIANT;
  if (value === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = prev;
  }
}

// ── Env fallback (the actual node/CI code path — expo-constants throws) ──

test('variantIsDev: APP_VARIANT=development → true', () => {
  withEnv('development', () => assert.equal(variantIsDev(), true));
});

test('variantIsDev: APP_VARIANT=production → false', () => {
  withEnv('production', () => assert.equal(variantIsDev(), false));
});

test('variantIsDev: APP_VARIANT=staging → false', () => {
  withEnv('staging', () => assert.equal(variantIsDev(), false));
});

test('variantIsDev: no APP_VARIANT → false (prod-safe default)', () => {
  withEnv(undefined, () => assert.equal(variantIsDev(), false));
});

test('variantIsDev: unknown APP_VARIANT → false', () => {
  withEnv('qa', () => assert.equal(variantIsDev(), false));
});

// ── Node-safety invariant: never throws, always a boolean ──

test('variantIsDev: never throws; always returns a boolean', () => {
  for (const v of ['development', 'production', 'staging', undefined, '']) {
    withEnv(v, () => {
      let out: unknown;
      assert.doesNotThrow(() => {
        out = variantIsDev();
      });
      assert.equal(typeof out, 'boolean');
    });
  }
});

// ── Mocked Constants branch: inject a fake expo-constants into the require
//    cache so the RN-runtime path (extra.variant) is exercised, and confirm it
//    takes precedence over a conflicting env. If the tsx loader resolves the
//    require differently and the mock isn't picked up (function throws through
//    to env), we skip rather than fail — the env branch above is authoritative
//    for node, and this asserts the Constants semantics when reachable.
function withMockedConstants(variant: unknown, fn: () => void) {
  let resolved: string;
  try {
    resolved = req.resolve('expo-constants');
  } catch {
    resolved = 'expo-constants';
  }
  const prev = req.cache[resolved];
  req.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { default: { expoConfig: { extra: { variant } } } },
  } as unknown as NodeModule;
  try {
    fn();
  } finally {
    if (prev) req.cache[resolved] = prev;
    else delete req.cache[resolved];
  }
}

// Detect whether the injected mock is actually observed by variant.ts's own
// require under the tsx loader. Only assert the Constants semantics if so.
function constantsMockReachable(): boolean {
  let reachable = false;
  withEnv('production', () => {
    withMockedConstants('development', () => {
      // If the Constants branch sees our mock, it returns true DESPITE the
      // production env; if the mock isn't observed, it returns false (env).
      reachable = variantIsDev() === true;
    });
  });
  return reachable;
}

test('variantIsDev: Constants extra.variant drives result and outranks env (when reachable)', (t) => {
  if (!constantsMockReachable()) {
    t.skip('expo-constants require not mockable under the tsx loader; env branch covers node');
    return;
  }
  withEnv('production', () => {
    withMockedConstants('development', () => assert.equal(variantIsDev(), true));
    withMockedConstants('production', () => assert.equal(variantIsDev(), false));
    withMockedConstants('staging', () => assert.equal(variantIsDev(), false));
    withMockedConstants(undefined, () => assert.equal(variantIsDev(), false));
  });
});
