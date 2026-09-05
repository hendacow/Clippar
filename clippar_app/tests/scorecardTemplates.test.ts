import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const types = readFileSync(join(root, 'modules/shot-detector/index.ts'), 'utf8');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
const reel = readFileSync(join(root, 'lib/reelScorecard.ts'), 'utf8');
const editor = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
const preview = readFileSync(join(root, 'app/round/preview.tsx'), 'utf8');
const swift = readFileSync(join(root, 'modules/shot-detector/ios/ShotDetectorModule.swift'), 'utf8');

// Henry, 4/5 Sep: choose the reel's scorecard — classic, words-only, a Tour
// card, a broadcast card, an Augusta-style header with the player's name.
test('the template travels from the picker to the native card', () => {
  assert.match(types, /export type ScorecardTemplate = 'classic' \| 'minimal' \| 'euro' \| 'pga' \| 'masters' \| 'training';/);
  assert.match(types, /template\?: ScorecardTemplate;/);
  assert.match(types, /playerName\?: string;/);
  assert.match(storage, /ALTER TABLE local_rounds ADD COLUMN scorecard_template TEXT/);
  assert.match(storage, /scorecard_template\?: string;/);
  assert.match(reel, /extra\?: \{ template\?: ScorecardTemplate; playerName\?: string \}/);
  assert.match(editor, /SCORECARD_TEMPLATES\.map\(\(t\) =>/);
  assert.match(editor, /storage\.updateLocalRound\(roundId, \{ scorecard_template: t \}\)/, 'the choice is saved on the round');
  assert.match(editor, /\{ template: isTraining \? 'training' : scorecardTemplate, playerName \}/);
  assert.match(editor, /label: trainingHoleLabel\(hole\.holeNumber\)/, 'practice reels carry the club name');
});

test('the preview mirrors every design', () => {
  assert.match(preview, /template === 'minimal'/);
  assert.match(preview, /HOLE \{currentHole\.holeNumber\} · PAR \{currentHole\.par\}/);
  assert.match(preview, /template === 'masters' \?/);
  assert.match(preview, /borderRadius: diff < 0 \? 10 : 3/, 'circle under par, square over par');
  assert.match(preview, /template=\{scorecardTemplate\} playerName=\{playerName\}/);
});

test('native draws all six looks and still decodes an old payload', () => {
  assert.match(swift, /let template: String\?/);
  assert.match(swift, /let playerName: String\?/);
  assert.match(swift, /let label: String\?/);
  for (const t of ['minimal', 'euro', 'pga', 'masters', 'training']) {
    assert.match(swift, new RegExp(`case "${t}"`), `Swift handles ${t}`);
  }
});
