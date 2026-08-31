import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const host = readFileSync(join(root, 'app/(onboarding)/index.tsx'), 'utf8');
const screens = readFileSync(join(root, 'components/onboarding/flow/Screens.tsx'), 'utf8');
const aha = readFileSync(join(root, 'components/onboarding/flow/AhaScreen.tsx'), 'utf8');

test('first-run path is the five-step fast-to-value funnel', () => {
  const stepBlock = host.match(/const STEPS = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
  const activeSteps = stepBlock.match(/^\s*[A-Z][A-Za-z]+Screen,/gm) ?? [];
  assert.equal(activeSteps.length, 5);
  assert.match(stepBlock, /HeroScreen[\s\S]*IntentScreen[\s\S]*AhaScreen[\s\S]*ReelReadyScreen[\s\S]*ProGateScreen/);
  assert.doesNotMatch(stepBlock, /CourseScreen|HandicapScreen|AgeScreen|ProblemScreen/);
});

test('the funnel promises value first and offers a permission-free sample path', () => {
  assert.match(screens, /Turn every round into a reel worth keeping/);
  assert.match(screens, /Make my first reel/);
  // Renamed 31 Aug when the sample became the interactive par-5 round (§13.5).
  assert.match(aha, /Play the sample round instead/);
  assert.match(aha, /No course setup needed/);
});
