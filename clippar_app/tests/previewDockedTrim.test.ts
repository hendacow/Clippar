import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The preview's trim bar used to live behind a scissors button: invisible
// until tapped, a full-screen mode while open. Henry's ask was the opposite —
// the bar is ALWAYS at the bottom, and "mode" only means "the user is
// mid-edit" (a handle grabbed and not yet saved), which is all that may hold
// the reel on a clip. These pins keep the docked semantics from quietly
// regressing back into a toggle:
//
//   1. the scissors toggle is gone from live code, not merely hidden;
//   2. the panel renders for every clip, un-gated by any mode flag;
//   3. mid-edit is DERIVED from dirty/dragging, and dirty is set by grabbing
//      a handle — never by programmatic bounds updates (the duration probe),
//      which would freeze the reel with no user input;
//   4. clips without a real duration (Supabase rows carry durationMs 0) get
//      no handles and no Save until a probe finds one — an always-on bar
//      must never let a fake 5s timeline produce a trim that loops at
//      frame 0.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

/** Source with comments removed, for the "this identifier is gone"
 *  assertions — comments may keep naming what they removed. */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SRC = 'app/round/preview.tsx';

// 4 Sep: the scissors is BACK — not as the old trim-mode toggle, but as the
// way into the full shared trimmer (ClipTrimModal: thick handles, hold-to-
// zoom, swipe/tap across shots). The docked panel stays for quick nudges.
test('the scissors opens the full trimmer; the old mode toggle stays gone', () => {
  const code = readCode(SRC);
  assert.doesNotMatch(code, /toggleTrimMode/);
  assert.match(code, /setFullTrimOpen\(true\)/);
  assert.match(code, /<ClipTrimModal/);
});

test('the trim panel renders for every clip, with no mode gate', () => {
  const src = read(SRC);
  assert.match(src, /\{currentClip && \(\s*<>\s*<ClipTrimModal[\s\S]*?<InlineTrimPanel/);
  assert.doesNotMatch(src, /\{trimMode && currentClip && \(\s*<InlineTrimPanel/);
});

test('mid-edit is derived, and only a grabbed handle marks the clip dirty', () => {
  const code = readCode(SRC);
  assert.match(code, /const trimMode = trimDirty \|\| draggingHandle !== 'none'/);
  assert.match(code, /if \(handle !== 'none'\) setTrimDirty\(true\)/);
  // The bounds-change handler must not set dirty — the duration probe
  // reports bounds programmatically and must never freeze the reel.
  const boundsHandler = code.slice(
    code.indexOf('const handleTrimBoundsChange'),
    code.indexOf('const handleDraggingHandle'),
  );
  assert.doesNotMatch(boundsHandler, /setTrimDirty\(true\)/);
});

test('no real duration → no handles, no Save', () => {
  const src = read(SRC);
  assert.match(src, /\{durationKnown && \(/);
  assert.match(src, /disabled=\{savingTrim \|\| !durationKnown\}/);
});
