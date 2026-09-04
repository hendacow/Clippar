import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const cin = readFileSync(join(root, 'components/onboarding/cinematic/CinematicOnboarding.tsx'), 'utf8');
const host = readFileSync(join(root, 'app/(onboarding)/index.tsx'), 'utf8');
const funnel = readFileSync(join(root, 'lib/onboardingFunnel.ts'), 'utf8');
const shutter = readFileSync(join(root, 'hooks/useShutter.ts'), 'utf8');
const sales = readFileSync(join(root, 'lib/salesFlow.ts'), 'utf8');
const rootLayout = readFileSync(join(root, 'app/_layout.tsx'), 'utf8');
const diagnostics = readFileSync(join(root, 'app/profile/diagnostics.tsx'), 'utf8');

// 3 Sep: the recording lesson IS the production interface — the real
// ScoreOverlay and RecordingIndicator, the real End Round pill — over
// Henry's footage. Not a green stand-in clicker. The double/triple-tap
// lessons were cut at Henry's instruction, so the shutter window is no
// longer exercised here (the real screen still owns it).
test('the recording lesson renders the real record-screen chrome', () => {
  assert.match(shutter, /export const CLICK_WINDOW_MS = 1000;/, 'the production window is untouched');
  assert.match(cin, /import \{ ScoreOverlay \} from '@\/components\/record\/ScoreOverlay';/);
  assert.match(cin, /import \{ RecordingIndicator \} from '@\/components\/record\/RecordingIndicator';/);
  assert.match(cin, /<ScoreOverlay/);
  assert.match(cin, /<RecordingIndicator isRecording=/);
  assert.match(cin, /End Round/);
  assert.doesNotMatch(cin, /function MultiTapScene|function ClickerIntroScene/, 'cut scenes are gone');
});

// Henry's footage insight: the held-at-address shot is a paused player, not
// purpose-filmed footage. 4 Sep: NO slow-mo on the strike — the real app
// does not do that, so the lesson must not pretend it does.
test('freeze-frame replaces purpose-filmed footage; no fake slow-mo', () => {
  assert.match(cin, /p\.pause\(\); \/\/ frame one = Henry at address/);
  assert.doesNotMatch(cin, /playbackRate = 0\.5/, 'slow-mo on the strike is gone');
  assert.match(cin, /lesson: require\('@\/assets\/onboarding\/lesson_shot\.mp4'\)/, 'the lesson clip is Henry');
  assert.doesNotMatch(cin, /shot1\.mp4/, 'the other golfer\'s clip is out');
});

// 4 Sep: the range light. The practice screen's CameraView never enabled the
// torch, so the "recording" light only ever worked on a round.
test('the range turns the recording light on while a clip records', () => {
  const range = readFileSync(join(root, 'app/training/record.tsx'), 'utf8');
  assert.match(range, /enableTorch=\{camera\.isRecording\}/);
});

// 4 Sep: the story-framed demo reel loops.
test('the demo reel loops inside its story frame', () => {
  const demo = cin.slice(cin.indexOf('function DemoReelScene'), cin.indexOf('function StorylineScene'));
  assert.match(demo, /p\.loop = true;/);
  assert.match(demo, /withRepeat\(withTiming\(1, \{ duration: 15000/);
});

// First cold start cannot depend on the update channel (5s fallback window).
test('tutorial videos ride the binary, within budget', () => {
  // Montage replaced by the frame-verified last-hole hero (§13.1); retired
  // assets live in assets/onboarding-archive, outside the bundled dir.
  assert.match(cin, /require\('@\/assets\/onboarding\/hero\.mp4'\)/);
  const dir = join(root, 'assets/onboarding');
  const total = readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  // 35MB: the hero, one address clip, the stitched sample reel, the 5x demo
  // reel, four posters, the trimmer still and the share mock.
  assert.ok(total < 35 * 1024 * 1024, `onboarding assets ${Math.round(total / 1e6)}MB exceed the 35MB budget`);
});

// A stalled video must never wedge onboarding.
test('every scene has a wedge-guard timeout and skip is always reachable', () => {
  assert.match(cin, /SCENE_TIMEOUT_MS/);
  assert.match(cin, /setTimeout\(advance, SCENE_TIMEOUT_MS\[scene\]\)/);
  assert.match(cin, /setShowSkip\(true\), 3000/);
});

// 3 Sep: the cinematic flow ends on signup. It must never hand into the v1
// stepper — its camera-roll import and par-5 sample round were cut.
test('the cinematic flow ends on signup, never the v1 stepper', () => {
  const block = host.match(/variant === 'v3' \|\| variant === 'v2'[\s\S]*?\/>\s*\);\s*\}/)?.[0] ?? '';
  assert.ok(block, 'v2 and v3 share one exit');
  assert.match(block, /router\.replace\('\/\(auth\)\/signup'\)/);
  assert.match(block, /onSkip=\{\(\) => void toSignup\(\)\}/, 'skip lands on signup too');
  assert.doesNotMatch(block, /setStep\(AHA_STEP_INDEX\)/, 'no hand-off into the stepper');
  assert.doesNotMatch(block, /setVariant\('v1'\)/);
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

// 3 Sep: the cinematic flow is the onboarding on every build.
test('variant default: v2 everywhere, override honoured', () => {
  assert.match(funnel, /return 'v2';/);
  assert.doesNotMatch(funnel, /appVariant === 'development' \? 'v2' : 'v1'/);
  assert.match(funnel, /onboarding\.variant/, 'diagnostics can still force a variant');
});

// Resume restarts the current scene from its top, never mid-video.
test('a killed run resumes at the top of its scene', () => {
  assert.match(cin, /SCENE_KEY/);
  assert.match(cin, /saved !== 'MONTAGE'/);
});

// 3 Sep: Henry cut the par-5 sample round outright and took the camera-roll
// import out of the funnel. The five raw clips left the bundle with it.
test('the par-5 sample round is gone and its clips are out of the bundle', () => {
  assert.ok(!existsSync(join(root, 'components/onboarding/flow/SampleRound.tsx')), 'SampleRound.tsx deleted');
  const aha = readFileSync(join(root, 'components/onboarding/flow/AhaScreen.tsx'), 'utf8');
  assert.doesNotMatch(aha, /SampleRound/);
  const bundled = readdirSync(join(root, 'assets/onboarding'));
  for (const f of ['sample1.mp4', 'sample5.mp4', 'shot1.mp4', 'shot2.mp4', 'shot3.mp4']) {
    assert.ok(!bundled.includes(f), `${f} must not ride the binary any more`);
  }
});

// 3 Sep: after the storyline, the share screen (Henry's Reel/Post/Story/
// Message mock, ground matched to the app black) and then the demo reel at
// 5x with the opening video's music. Then signup.
test('share screen and 5x demo reel close the flow', () => {
  assert.match(cin, /const SCENES = \[\s*'MONTAGE',\s*'RECORD',\s*'STORYLINE',\s*'SHARE',\s*'DEMO_REEL',\s*\] as const;/);
  assert.match(cin, /require\('@\/assets\/onboarding\/share_socials\.png'\)/);
  assert.match(cin, /require\('@\/assets\/onboarding\/demo_reel\.mp4'\)/);
  assert.match(cin, /function ShareScene/);
  assert.match(cin, /function DemoReelScene/);
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
  // 3 Sep: the words FADE in and are all up 3s before the clip ends; the
  // clip then loops under them until "Let's create your reel" is pressed.
  assert.match(cin, /const WORDS_DONE_BEFORE_END_S = 3;/);
  assert.match(cin, /currentTime >= p\.duration - WORDS_LEAD_S/, 'resolves off the clip clock, not a timer');
  assert.match(cin, /entering=\{FadeIn\.duration\(WORD_FADE_MS\)/, 'fade, not a zoom stamp');
  assert.match(cin, /<SceneVideo source=\{VIDEOS\.hero\} loop/, 'the hero loops once the words are up');
  assert.match(cin, /Let's create your reel/);
  assert.doesNotMatch(cin, /setTimeout\(onNext, 3000\)/, 'no auto-advance — the CTA is the exit');
  assert.doesNotMatch(cin, /CONTACT_MS/, 'the old mid-downswing stamp is gone');
});


// The cinematic intro is gated on being signed OUT with sales_done unset, so
// on a real handset it can never be seen again once finished — which meant
// there was no way to review it without deleting the app. The profile's
// "Replay onboarding" clears the in-app TOUR flags and is a different feature.
test('the cinematic intro can be replayed on a device that has finished it', () => {
  assert.match(sales, /export async function beginIntroReplay/);
  assert.match(sales, /setSetting\(DONE_KEY, null\)/, 'clears sales_done, not just the tour flags');
  assert.match(sales, /onboarding\.v2\.completed_at/);
  assert.match(diagnostics, /Replay cinematic intro/);
  assert.match(diagnostics, /beginIntroReplay/);

  // The root gate bounces a signed-in user out of (onboarding); the replay
  // needs one narrow exception or the button lands nowhere.
  assert.match(rootLayout, /inOnboardingGroup && isReplayingIntro\(\)/);

  // In-memory, never persisted: a relaunch must not be able to strand a
  // signed-in golfer inside the funnel.
  assert.doesNotMatch(sales, /setSetting\('onboarding\.replaying/);
  assert.match(sales, /let replayingIntro = false;/);

  // And it has to be switched off when the funnel exits, or the gate stays open.
  assert.match(host, /endIntroReplay\(\)/);
});
