import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const cin = readFileSync(join(root, 'components/onboarding/cinematic/CinematicOnboarding.tsx'), 'utf8');
const host = readFileSync(join(root, 'app/(onboarding)/index.tsx'), 'utf8');
const funnel = readFileSync(join(root, 'lib/onboardingFunnel.ts'), 'utf8');
const shutter = readFileSync(join(root, 'hooks/useShutter.ts'), 'utf8');

// The plan's central claim: the tutorial teaches the PRODUCTION interface.
test('the fake clicker resolves taps with the real shutter window', () => {
  assert.match(shutter, /export const CLICK_WINDOW_MS = 1000;/);
  assert.match(cin, /import \{ CLICK_WINDOW_MS \} from '@\/hooks\/useShutter';/);
  assert.match(cin, /setTimeout\(resolve, CLICK_WINDOW_MS\)/);
});

// Henry's footage insight: the held-at-address shot is a paused player, not
// purpose-filmed footage; slow-mo is a playbackRate change.
test('freeze-frame and playbackRate replace purpose-filmed footage', () => {
  assert.match(cin, /p\.pause\(\); \/\/ frame one = Henry at address/);
  assert.match(cin, /playbackRate = 0\.5/);
});

// First cold start cannot depend on the update channel (5s fallback window).
test('tutorial videos ride the binary, within budget', () => {
  // Montage replaced by the frame-verified last-hole hero (§13.1); retired
  // assets live in assets/onboarding-archive, outside the bundled dir.
  assert.match(cin, /require\('@\/assets\/onboarding\/hero\.mp4'\)/);
  const dir = join(root, 'assets/onboarding');
  const total = readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  // Budget raised to 35MB for the par-5 sample round (plan §13.5) — five
  // raw-capture clips, five strike posters and the stitched reel.
  assert.ok(total < 35 * 1024 * 1024, `onboarding assets ${Math.round(total / 1e6)}MB exceed the 35MB budget`);
});

// A stalled video must never wedge onboarding.
test('every scene has a wedge-guard timeout and skip is always reachable', () => {
  assert.match(cin, /SCENE_TIMEOUT_MS/);
  assert.match(cin, /setTimeout\(advance, SCENE_TIMEOUT_MS\[scene\]\)/);
  assert.match(cin, /setShowSkip\(true\), 3000/);
});

// Skip and completion both land on the real Aha step — never a dead end.
test('v2 hands off into the v1 stepper at the Aha step', () => {
  assert.match(host, /AHA_STEP_INDEX = 2/);
  assert.match(host, /setStep\(AHA_STEP_INDEX\)/);
  const v2block = host.match(/variant === 'v2'[\s\S]*?<\/CinematicOnboarding>|variant === 'v2'[\s\S]*?\/>\s*\);/)?.[0] ?? '';
  assert.match(v2block, /onSkip/);
});

// Rework 2 Sep: EXPORT lift-off replaced by the create-your-own STORYLINE
// (one continuous beat: four shots gather → merge → trim → stitch → reel).
// The kit-free / no-fake-post guarantees survive at the component level.
test('the create-your-own beat is a single storyline, no fake social UI', () => {
  assert.match(cin, /function StorylineScene/);
  assert.match(cin, /Recorded videos are long and hard to edit/);
  assert.match(cin, /AI trims everything into the few seconds that matter/);
  assert.match(cin, /Reel ready to share/);
  assert.doesNotMatch(cin, /igstory/i, 'the story recording stays retired');
  assert.doesNotMatch(cin, /function ExportScene|function PreviewScene/, 'the scrapped scenes are gone');
});

// v1 finally has funnel telemetry, so the comparison has a baseline.
test('both variants log the funnel', () => {
  assert.match(funnel, /export function logFunnel/);
  assert.match(host, /logFunnel\('v1'/);
  assert.match(cin, /logFunnel\('v2'/);
});

// Production stays v1 until v2 wins; dev defaults v2.
test('variant defaults: production v1, dev v2, override honoured', () => {
  assert.match(funnel, /appVariant === 'development' \? 'v2' : 'v1'/);
  assert.match(funnel, /onboarding\.variant/);
});

// Resume restarts the current scene from its top, never mid-video.
test('a killed run resumes at the top of its scene', () => {
  assert.match(cin, /SCENE_KEY/);
  assert.match(cin, /saved !== 'MONTAGE'/);
});

// Plan §13.5 — the sample round. Frame-verified inputs (one hole, strikes
// pinned at 9.9/6.9/10.0/5.9/4.2s), raw-feel clips in, offline reel out.
test('the sample round is five presses that become a reel', () => {
  const sr = readFileSync(join(root, 'components/onboarding/flow/SampleRound.tsx'), 'utf8');
  assert.match(sr, /sample1\.mp4/);
  assert.match(sr, /sample_reel\.mp4/);
  assert.match(sr, /playToEnd/, 'clips land when they end');
  assert.match(sr, /setTimeout\(\(\) => land\(idx\), 9000\)/, 'wedge guard on every raw clip');
  assert.match(sr, /never claims the reel is yours|Yours will look like this/, 'honest sample copy');
  const aha = readFileSync(join(root, 'components/onboarding/flow/AhaScreen.tsx'), 'utf8');
  assert.match(aha, /<SampleRound/, 'wired into the aha sample path');
  assert.match(aha, /setAhaOutcome\('sample'\)/, 'preserves the outcome contract');
});

// §13.6 as ratified: NO kit content in onboarding; earned observations only.
test('onboarding is kit-free and the earned moments are observations, not pitches', () => {
  assert.doesNotMatch(cin, /\bbuy\b|\bpurchase\b|order now|\bshop\b/i, 'no sell language in onboarding');
  const km = readFileSync(join(root, 'lib/kitMoments.ts'), 'utf8');
  assert.match(km, /no fact, no card/);
  const home = readFileSync(join(root, 'app/(tabs)/index.tsx'), 'utf8');
  assert.match(home, /walked back to your phone \$\{/, 'the number is interpolated from real facts');
  assert.doesNotMatch(home.match(/function KitMomentCard[\s\S]*?\n\}/)?.[0] ?? '', /buy|Buy|purchase|% off/, 'observation copy only');
  const rec = readFileSync(join(root, 'app/(tabs)/record.tsx'), 'utf8');
  assert.match(rec, /recordRoundFacts\(roundState\.clips\.length, shutter\.connected\)/, 'facts are genuinely derived');
});

// Rework 2 Sep: the hero holds on its final frame with the BLACK wordmark
// and "Every shot remembered" building one word at a time (haptic each),
// logo + words resolving together at the top. No mid-clip contact stamp.
test('the hero resolves the white lockup + stamped two-tone headline on the end frame', () => {
  // The WHITE variant is a measured decision, not a preference: on this sky
  // the black lockup put its green GOLF at 1.43:1 where large text needs
  // 3.0:1, and only one 5%-wide scrim window cleared 3.0 on both black and
  // green at once. White and green both want the same dark ground. Swapping
  // back to black looks like a harmless brand tweak and silently reintroduces
  // that, so this test exists to make it fail loudly instead.
  assert.match(cin, /clippar-logo-stacked-white\.png/);
  assert.doesNotMatch(cin, /clippar-logo-stacked-black\.png/, 'black reintroduces the 1.43:1 green');
  assert.doesNotMatch(cin, /clippar-logo-wordmark-black\.png/, 'the slab wordmark is not the logo');

  // The website treatment: two stacked lines, two-tone, full stops included.
  assert.match(cin, /const WORDS = \['EVERY', 'SHOT\.', 'REMEMBERED\.'\]/);
  assert.match(cin, /bigWordGreen/, 'REMEMBERED. is the brand green, not white');

  assert.match(cin, /ImpactFeedbackStyle\.Heavy/, 'a haptic per word');
  assert.match(cin, /currentTime >= p\.duration - 0\.25/, 'resolves on the final frame, not a timer');
  assert.match(cin, /if \(!resolved\) return;/, 'the words stamp on the END frame, not during the clip');
  assert.match(cin, /setTimeout\(onNext, 3000\)/, 'auto-advances once the last word has held');
  assert.doesNotMatch(cin, /CONTACT_MS/, 'the old mid-downswing stamp is gone');
});
