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
  assert.match(cin, /require\('@\/assets\/onboarding\/montage\.mp4'\)/);
  const dir = join(root, 'assets/onboarding');
  const total = readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  assert.ok(total < 20 * 1024 * 1024, `onboarding assets ${Math.round(total / 1e6)}MB exceed the 20MB budget`);
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

// The fake export never claims a real post happened. Checked against the
// USER-FACING strings only — a code comment may say "posting" (this file's
// does, describing Henry's real screen-recording); a golfer must never read
// it. Third self-defeating-grep of the day; this time a test caught it.
test('the export beat is marked EXAMPLE and its visible text never says post', () => {
  const exportScene = cin.match(/function ExportScene[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(exportScene, /EXAMPLE/);
  assert.match(exportScene, /VIDEOS\.igstory/, 'the beat plays the real story recording');
  assert.match(exportScene, /VIDEOS\.igstory/, 'the beat plays the real story recording');
  const visible = [...exportScene.matchAll(/<Text[^>]*>([\s\S]*?)<\/Text>/g)].map((m) => m[1]).join(' ');
  assert.ok(visible.length > 0, 'export scene should render text');
  assert.doesNotMatch(visible, /[Pp]ost(ed)?\b/);
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
