import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// App Review 3.1.2: a purchase screen — and the funnel that feeds it — may only
// advertise what the shipping binary delivers. config.tracer.enabled is false
// for v1 prod (the tracer has not passed a real-round field test), so a paying
// subscriber gets no tracer at all, while the paywall used to list "Shot tracer
// on every full swing" as one of four Pro unlocks and the onboarding funnel sold
// it with a drawn arc, a loader beat and two testimonials. That is a
// misrepresentation and a refund/chargeback risk.
//
// The fix was to DERIVE every tracer claim from config.tracer.enabled instead of
// hardcoding it, so copy and capability cannot drift apart again in either
// direction. These tests pin that: the strings must never appear as literals
// outside a guard on the flag. Note they deliberately do NOT assert the flag's
// value — flipping it on after a passing field test must keep them green.
//
// These surfaces import react-native, which the node test runner cannot
// transform, so they assert on source text — the same approach
// tempExportWiring.test.ts and privacyManifest.test.ts take.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const paywall = read('app/paywall.tsx');
const screens = read('components/onboarding/flow/Screens.tsx');
const mockReel = read('components/onboarding/flow/MockReel.tsx');
const onboardingFlow = read('constants/onboardingFlow.ts');
const config = read('constants/config.ts');

/** Strip line comments + block comments so prose about the tracer doesn't
 *  register as a user-facing claim. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('the tracer flag the claims hang off still exists', () => {
  // If this key is ever renamed, every guard below silently becomes dead code
  // and the claims come back on unnoticed.
  assert.match(
    config,
    /tracer:\s*\{[\s\S]*?enabled:\s*(true|false) as boolean/,
    'constants/config.ts must still expose config.tracer.enabled'
  );
});

test('the paywall never lists the tracer as an unlock unless the flag is on', () => {
  const code = codeOnly(paywall);
  const claim = /['"`][^'"`]*[Ss]hot tracer[^'"`]*['"`]/.exec(code);
  if (claim) {
    // A tracer line may exist, but only inside a config.tracer.enabled guard.
    const guarded = /config\.tracer\.enabled\s*\?\s*\[[^\]]*[Ss]hot tracer/.test(code);
    assert.ok(
      guarded,
      `app/paywall.tsx lists ${claim[0]} unguarded — a Pro benefit the build may not deliver ` +
        '(App Review 3.1.2). Gate it on config.tracer.enabled.'
    );
  }
  // Whatever else it lists, the array must be built from the flag.
  assert.match(
    code,
    /PRO_FEATURES\s*=\s*\[[\s\S]*?config\.tracer\.enabled/,
    'PRO_FEATURES must derive the tracer line from config.tracer.enabled, not hardcode it'
  );
  assert.match(code, /from '@\/constants\/config'/);
});

test('the paywall does not bill ungated settings as a Pro unlock', () => {
  // Trim Settings is an ungated row in app/(tabs)/profile.tsx — free users
  // already have it, so selling it was the same misrepresentation as the tracer.
  assert.doesNotMatch(
    codeOnly(paywall),
    /detection\s*&?\s*(and\s*)?trim settings/i,
    'app/paywall.tsx must not advertise trim/detection settings as Pro — they are not gated'
  );
});

test('the onboarding funnel never promises a tracer unless the flag is on', () => {
  // Proximity check rather than a per-literal regex: the reveal subhead is a
  // multi-line template literal, so "guard and claim on one line" is too strict.
  // Every mention of the tracer in executable code must sit inside the reach of
  // a config.tracer.enabled guard (the guard's own occurrence satisfies itself).
  const WINDOW = 200;
  for (const [name, src] of [
    ['components/onboarding/flow/Screens.tsx', screens],
    ['constants/onboardingFlow.ts', onboardingFlow],
  ] as const) {
    const code = codeOnly(src);
    for (const m of code.matchAll(/tracer/gi)) {
      const at = m.index ?? 0;
      const window = code.slice(Math.max(0, at - WINDOW), at + 40);
      assert.ok(
        window.includes('config.tracer.enabled'),
        `${name} mentions the tracer at offset ${at} with no config.tracer.enabled guard ` +
          `within ${WINDOW} chars:\n…${code.slice(Math.max(0, at - 90), at + 60)}…\n` +
          'Gate it on the flag — the shipping build may not draw an arc at all.'
      );
    }
  }
});

test('the hero reel only plays the tracer scene when the flag is on', () => {
  const code = codeOnly(mockReel);
  // The drive scene IS the tracer (TracerArc draws the whole frame), so the
  // scene list itself must be flag-derived — otherwise the funnel shows an arc
  // the build cannot produce.
  assert.match(
    code,
    /SCENES[^=]*=\s*config\.tracer\.enabled\s*\?/,
    'MockReel SCENES must be derived from config.tracer.enabled'
  );
  assert.match(
    code,
    /config\.tracer\.enabled\s*\?\s*'[^']*TRACER ON'/,
    "the end card's TRACER ON meta line must be flag-derived"
  );
  // The cycle/hold logic must follow the list length, not a hardcoded 3 — with
  // the tracer off there are only two scenes, and `% 3` would render blanks.
  assert.match(code, /%\s*SCENES\.length/, 'scene cycling must use SCENES.length');
  assert.match(
    code,
    /setSceneIdx\(SCENES\.length - 1\)/,
    'the Reduce Motion hold must target the last scene in SCENES, not index 2'
  );
  assert.doesNotMatch(code, /scene === [0-9]/, 'scenes are addressed by name, not by index');
});
