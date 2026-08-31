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

// §13.4: the IG framing is retired — the export beat is the lift-off, with
// anonymous slots and no social branding. Nothing may claim a real post
// happened; "Anywhere you post" names the user's own future act.
test('the export beat fakes nothing: no IG asset, anonymous slots, honest gag', () => {
  const exportScene = cin.match(/function ExportScene[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(cin, /igstory/i, 'the story recording is fully retired from onboarding');
  assert.match(exportScene, /appSlot/);
  assert.match(exportScene, /That was the whole export/);
  const visible = [...exportScene.matchAll(/<Text[^>]*>([\s\S]*?)<\/Text>/g)].map((m) => m[1]).join(' ');
  assert.doesNotMatch(visible, /[Pp]osted\b/, 'never claims a post happened');
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

// The hero stamps the REAL wordmark at the contact frame — no styled text.
test('the hero uses the real logo, stamped at contact', () => {
  assert.match(cin, /clippar-logo-wordmark\.png/);
  assert.doesNotMatch(cin, /styles\.brand[^W]/, 'the styled-text brand is gone');
  assert.match(cin, /CONTACT_MS = 800/);
});
