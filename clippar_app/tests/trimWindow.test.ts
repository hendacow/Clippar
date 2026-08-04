import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  config,
  resolveSavedTrimWindow,
  resolveEffectiveTrimWindow,
  splitDurationPreset,
  TRIM_WINDOW_MARKER,
  MIN_TRIM_ROLL_MS,
  MAX_TRIM_ROLL_MS,
} from '../constants/config';

// Profile → Trim Settings used to be a screen where nothing you touched
// mattered. Both pickers and all three duration presets wrote to storage,
// reported success, and every clip still trimmed to 2500/1500, because the two
// readers only honoured an override carrying `window: 'fullSwing'` and the
// settings screen had never written that marker. A guard built to ignore STALE
// overrides ignored EVERY override instead — including the one set seconds ago.
//
// These tests pin the two halves that failure needed:
//   1. a window saved by today's UI takes effect, and a pre-FIX-#8 one does not;
//   2. live capture and import re-trim resolve the SAME window for the same
//      stored value — if they ever diverge, a clip re-trimmed in the editor is
//      a different length from the one that was recorded, and the round it came
//      from cannot be shot again.
//
// Everything malformed resolves toward KEEPING footage. There is no correct
// amount of a golfer's only round to throw away because a JSON blob was
// truncated.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

/**
 * Source with comments removed, for the "this identifier is gone" assertions.
 * The comments are where the removals are JUSTIFIED and must keep naming what
 * they removed — only live code is being asserted about.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const DEFAULT = config.trim.windows.fullSwing;

/** Exactly what app/profile/trim-settings.tsx writes when a chip is tapped. */
const savedByTodaysUi = (preRollMs: number, postRollMs: number) =>
  JSON.stringify({ preRollMs, postRollMs, window: TRIM_WINDOW_MARKER });

// ─── The bug: a window the user just set must actually take effect ───

test('a window saved by today’s UI is honoured', () => {
  assert.deepEqual(resolveSavedTrimWindow(savedByTodaysUi(4000, 5000)), {
    preRollMs: 4000,
    postRollMs: 5000,
  });
  // And the tighter end of the pickers, which is the direction that costs
  // footage — it is still the user's explicit choice, so it stands.
  assert.deepEqual(resolveSavedTrimWindow(savedByTodaysUi(1000, 1000)), {
    preRollMs: 1000,
    postRollMs: 1000,
  });
});

test('every duration preset survives the round trip through storage', () => {
  for (const preset of config.trim.durationPresets) {
    const chosen = splitDurationPreset(preset);
    assert.deepEqual(
      resolveSavedTrimWindow(savedByTodaysUi(chosen.preRollMs, chosen.postRollMs)),
      chosen,
      `preset ${preset}ms must reach the trimmer unchanged`
    );
  }
});

// ─── The guard the bug came from: stale overrides still must not win ───

test('a pre-FIX-#8 override carries no marker and is ignored', () => {
  // What the old screen wrote: the legacy 3000/2000 window, no `window` field.
  // Honouring it would pin day-zero users to the old length forever.
  const legacy = JSON.stringify({ autoTrimEnabled: true, preRollMs: 3000, postRollMs: 2000 });
  assert.deepEqual(resolveSavedTrimWindow(legacy), {
    preRollMs: DEFAULT.preRollMs,
    postRollMs: DEFAULT.postRollMs,
  });
});

test('a wrong or absent marker never unlocks the override', () => {
  const cases = [
    JSON.stringify({ preRollMs: 4000, postRollMs: 5000 }),
    JSON.stringify({ preRollMs: 4000, postRollMs: 5000, window: 'baseline' }),
    JSON.stringify({ preRollMs: 4000, postRollMs: 5000, window: null }),
    JSON.stringify({ preRollMs: 4000, postRollMs: 5000, window: true }),
  ];
  for (const saved of cases) {
    assert.deepEqual(
      resolveSavedTrimWindow(saved),
      { preRollMs: DEFAULT.preRollMs, postRollMs: DEFAULT.postRollMs },
      `untagged/mis-tagged override must not apply: ${saved}`
    );
  }
});

// ─── Nothing malformed may produce a shorter window than the default ───

test('no stored value at all resolves to the config window', () => {
  for (const saved of [null, undefined, '']) {
    assert.deepEqual(resolveSavedTrimWindow(saved), {
      preRollMs: DEFAULT.preRollMs,
      postRollMs: DEFAULT.postRollMs,
    });
  }
});

test('non-JSON and non-object values fall back, never throw', () => {
  for (const saved of ['{"preRollMs":25', 'not json at all', '"fullSwing"', '42', 'null', '[]']) {
    const w = resolveSavedTrimWindow(saved);
    assert.deepEqual(
      w,
      { preRollMs: DEFAULT.preRollMs, postRollMs: DEFAULT.postRollMs },
      `garbage must resolve to the default window: ${saved}`
    );
  }
});

test('a tagged blob with junk numbers keeps the default on the junk field only', () => {
  // The dangerous outcome is 0 or NaN reaching native, which reads as "keep
  // nothing on that side of impact" — the swing itself is what gets cut.
  const junk = [0, -1, -5000, NaN, Infinity, -Infinity, null, undefined, '3000', {}];
  for (const bad of junk) {
    const w = resolveSavedTrimWindow(
      JSON.stringify({ preRollMs: bad, postRollMs: 5000, window: TRIM_WINDOW_MARKER })
    );
    assert.deepEqual(
      w,
      { preRollMs: DEFAULT.preRollMs, postRollMs: 5000 },
      `preRollMs ${String(bad)} must fall back to the default, not to zero`
    );
    assert.ok(Number.isFinite(w.preRollMs) && w.preRollMs > 0);
  }
});

test('a partial save leaves the missing side at the default, not at zero', () => {
  assert.deepEqual(
    resolveSavedTrimWindow(JSON.stringify({ preRollMs: 4000, window: TRIM_WINDOW_MARKER })),
    { preRollMs: 4000, postRollMs: DEFAULT.postRollMs }
  );
  assert.deepEqual(
    resolveSavedTrimWindow(JSON.stringify({ postRollMs: 4000, window: TRIM_WINDOW_MARKER })),
    { preRollMs: DEFAULT.preRollMs, postRollMs: 4000 }
  );
  assert.deepEqual(resolveSavedTrimWindow(JSON.stringify({ window: TRIM_WINDOW_MARKER })), {
    preRollMs: DEFAULT.preRollMs,
    postRollMs: DEFAULT.postRollMs,
  });
});

test('values below the smallest chip are corruption, not intent', () => {
  // No picker can write 400ms. Trusting it would trim more aggressively than
  // the user ever asked for, so it reverts to the default window.
  const w = resolveSavedTrimWindow(
    JSON.stringify({ preRollMs: 400, postRollMs: MIN_TRIM_ROLL_MS - 1, window: TRIM_WINDOW_MARKER })
  );
  assert.deepEqual(w, { preRollMs: DEFAULT.preRollMs, postRollMs: DEFAULT.postRollMs });
});

test('absurdly large values clamp rather than revert', () => {
  // Clamping keeps MORE of the clip than falling back to 2500/1500 would, and
  // "kept too much" is a problem the editor can fix after the round.
  const w = resolveSavedTrimWindow(
    JSON.stringify({ preRollMs: 9e9, postRollMs: 60_000, window: TRIM_WINDOW_MARKER })
  );
  assert.deepEqual(w, { preRollMs: MAX_TRIM_ROLL_MS, postRollMs: MAX_TRIM_ROLL_MS });
  assert.ok(MAX_TRIM_ROLL_MS > DEFAULT.preRollMs && MAX_TRIM_ROLL_MS > DEFAULT.postRollMs);
});

test('a fractional roll is rounded, never truncated toward zero', () => {
  assert.deepEqual(
    resolveSavedTrimWindow(
      JSON.stringify({ preRollMs: 2500.6, postRollMs: 1500.4, window: TRIM_WINDOW_MARKER })
    ),
    { preRollMs: 2501, postRollMs: 1500 }
  );
});

// ─── The two readers must agree, always ───

test('live capture and import re-trim resolve identically for the same value', () => {
  // Both hooks call resolveEffectiveTrimWindow and nothing else, so this is the
  // property that matters: one stored value, one answer, whichever path asks.
  const stored = [
    null,
    '',
    'garbage',
    JSON.stringify({ preRollMs: 3000, postRollMs: 2000 }), // legacy
    savedByTodaysUi(4000, 5000),
    savedByTodaysUi(1000, 1000),
    JSON.stringify({ preRollMs: NaN, postRollMs: 0, window: TRIM_WINDOW_MARKER }),
  ];
  for (const saved of stored) {
    const capture = resolveEffectiveTrimWindow(saved);
    const editor = resolveEffectiveTrimWindow(saved);
    assert.deepEqual(capture, editor, `readers disagree for ${String(saved)}`);
    assert.ok(capture.preRollMs > 0 && capture.postRollMs > 0);
  }
});

test('the tracer bonus is added once, on the pipeline window only', () => {
  const tracer = config.tracer as unknown as { enabled: boolean; extraPostRollMs: number };
  const wasEnabled = tracer.enabled;
  const wasExtra = tracer.extraPostRollMs;
  try {
    tracer.enabled = true;
    tracer.extraPostRollMs = 2000;
    const saved = savedByTodaysUi(2500, 1500);
    // What the settings screen edits stays clean...
    assert.deepEqual(resolveSavedTrimWindow(saved), { preRollMs: 2500, postRollMs: 1500 });
    // ...so re-saving it cannot compound the bonus on the next read.
    assert.deepEqual(resolveEffectiveTrimWindow(saved), { preRollMs: 2500, postRollMs: 3500 });
    const roundTripped = savedByTodaysUi(
      resolveSavedTrimWindow(saved).preRollMs,
      resolveSavedTrimWindow(saved).postRollMs
    );
    assert.deepEqual(resolveEffectiveTrimWindow(roundTripped), {
      preRollMs: 2500,
      postRollMs: 3500,
    });
  } finally {
    tracer.enabled = wasEnabled;
    tracer.extraPostRollMs = wasExtra;
  }
});

test('day-zero (tracer off) the pipeline window is the saved window', () => {
  assert.equal(config.tracer.enabled, false);
  const saved = savedByTodaysUi(3500, 2500);
  assert.deepEqual(resolveEffectiveTrimWindow(saved), resolveSavedTrimWindow(saved));
});

// ─── Duration presets must land on chips, and never below the label ───

test('every preset splits onto values the pickers can actually show', () => {
  for (const preset of config.trim.durationPresets) {
    const { preRollMs, postRollMs } = splitDurationPreset(preset);
    assert.ok(
      config.trim.preRollOptionsMs.includes(preRollMs),
      `preset ${preset}ms produced an un-showable pre-roll ${preRollMs}`
    );
    assert.ok(
      config.trim.postRollOptionsMs.includes(postRollMs),
      `preset ${preset}ms produced an un-showable post-roll ${postRollMs}`
    );
  }
});

test('a preset never keeps less than the length on its label', () => {
  for (const preset of config.trim.durationPresets) {
    const { preRollMs, postRollMs } = splitDurationPreset(preset);
    assert.ok(
      preRollMs + postRollMs >= preset,
      `preset ${preset}ms resolved to ${preRollMs + postRollMs}ms — rounding must go up`
    );
    // ...and still inside the ±200ms the screen uses to highlight the preset.
    assert.ok(Math.abs(preRollMs + postRollMs - preset) < 200);
  }
});

test('the 4s preset is the app default, not a different four seconds', () => {
  assert.deepEqual(splitDurationPreset(4000), {
    preRollMs: DEFAULT.preRollMs,
    postRollMs: DEFAULT.postRollMs,
  });
});

// ─── Wiring: the parts the pure logic cannot check about itself ───

test('the settings screen stamps the marker the readers gate on', () => {
  // THE regression. Without this literal in the save path, every control on the
  // screen is decorative and the failure is completely silent.
  const screen = readCode('app/profile/trim-settings.tsx');
  assert.match(
    screen,
    /setSetting\(\s*'trim_settings',\s*JSON\.stringify\(\{[^}]*window:\s*TRIM_WINDOW_MARKER/,
    'saving trim settings must tag the blob with TRIM_WINDOW_MARKER'
  );
});

test('the settings screen shows the window the pipeline will use', () => {
  const screen = readCode('app/profile/trim-settings.tsx');
  assert.match(
    screen,
    /resolveSavedTrimWindow\(saved\)/,
    'initial values must come from the readers’ own resolver'
  );
  assert.doesNotMatch(
    screen,
    /defaultPreRollMs|defaultPostRollMs/,
    'the legacy 3000/2000 "defaults" are not what anything trims to'
  );
});

test('the dead Auto-trim switch is gone, not merely hidden', () => {
  const screen = readCode('app/profile/trim-settings.tsx');
  assert.doesNotMatch(screen, /<Switch/, 'a switch nothing reads must not be on screen');
  assert.doesNotMatch(screen, /autoTrimEnabled/, 'no state left behind for it either');
  assert.doesNotMatch(
    readCode('constants/config.ts'),
    /autoTrimEnabled/,
    'the config flag it read went with it'
  );
  assert.equal(
    (config.trim as Record<string, unknown>).autoTrimEnabled,
    undefined,
    'nothing may resurrect it by reading config.trim.autoTrimEnabled'
  );
});

test('neither reader re-implements the guard', () => {
  // Two hand-mirrored copies is how they drifted apart the first time.
  for (const rel of ['hooks/useCamera.ts', 'hooks/useEditorState.ts']) {
    const src = readCode(rel);
    assert.match(src, /resolveEffectiveTrimWindow\(saved\)/, `${rel} must use the shared resolver`);
    assert.doesNotMatch(
      src,
      /window\s*===/,
      `${rel} must not re-implement the marker check`
    );
    assert.doesNotMatch(
      src,
      /config\.tracer\.extraPostRollMs/,
      `${rel} must not add the tracer bonus a second time`
    );
  }
});
