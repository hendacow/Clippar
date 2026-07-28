/**
 * Admission control for the Bluetooth shutter.
 *
 *   npm test
 *
 * The security half of this is BLE-002 (debounce AND rate limit an untrusted
 * external input). The half that matters more day to day is the opposite
 * direction: this code sits directly between the golfer's thumb and the camera,
 * and if it drops a real press the user misses the shot. A missed shot cannot be
 * re-recorded — they are standing on a fairway, the ball is already gone.
 *
 * So most of what follows asserts that ordinary human presses get through, and
 * only then that hostile ones do not.
 *
 * Values mirror hooks/useShutter.ts: MIN_SAME_SOURCE_INTERVAL_MS = 120,
 * DUP_WINDOW_MS = 120, RATE_WINDOW_MS = 1000, RATE_MAX_EVENTS = 8.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitShutterPress } from '../lib/shutterGuards';

const CFG = {
  minSameSourceIntervalMs: 120,
  dupWindowMs: 120,
  rateWindowMs: 1000,
  rateMaxEvents: 8,
};

function admit(over: Partial<Parameters<typeof admitShutterPress>[0]> = {}) {
  return admitShutterPress({
    source: 'hid',
    nowMs: 10_000,
    lastEmitBySource: {},
    recentEventsMs: [],
    ...CFG,
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The user must always get through
// ─────────────────────────────────────────────────────────────────────────────

test('a lone press is accepted', () => {
  assert.equal(admit().admission, 'accept');
});

test('a deliberate double-click is accepted', () => {
  // A human double-click is 150-400ms apart. Both halves must count or the
  // gesture resolver never sees a 2-click.
  const first = admit({ nowMs: 10_000 });
  assert.equal(first.admission, 'accept');
  const second = admit({
    nowMs: 10_250,
    lastEmitBySource: { hid: 10_000 },
    recentEventsMs: first.recentEventsMs,
  });
  assert.equal(second.admission, 'accept');
});

test('a deliberate triple-click is accepted', () => {
  // Three clicks is the penalty gesture. Dropping the third would silently
  // change what the golfer recorded.
  let recent: number[] = [];
  const last: Record<string, number> = {};
  for (const t of [10_000, 10_220, 10_440]) {
    const r = admit({ nowMs: t, lastEmitBySource: { ...last }, recentEventsMs: recent });
    assert.equal(r.admission, 'accept', `press at ${t}`);
    recent = r.recentEventsMs;
    last.hid = t;
  }
});

test('a full round of presses at human pace is never throttled', () => {
  // 40 presses, ~2s apart — a whole round. The sliding window must drain.
  let recent: number[] = [];
  const last: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const t = 10_000 + i * 2_000;
    const r = admit({ nowMs: t, lastEmitBySource: { ...last }, recentEventsMs: recent });
    assert.equal(r.admission, 'accept', `press ${i}`);
    recent = r.recentEventsMs;
    last.hid = t;
  }
});

test('the window prunes events older than rateWindowMs', () => {
  // Otherwise the array grows for the whole round and eventually trips the cap.
  const r = admit({ nowMs: 20_000, recentEventsMs: [10_000, 10_100, 19_500] });
  assert.deepEqual(r.recentEventsMs, [19_500, 20_000]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Hostile input must not
// ─────────────────────────────────────────────────────────────────────────────

test('a flood beyond the cap is dropped', () => {
  // A second shutter left switched on in the golf bag autorepeats. Unbounded,
  // every event re-armed the ~1s click-flush timer, so the golfer's own press
  // could never resolve — the camera simply stopped responding.
  const recent = Array.from({ length: 8 }, (_, i) => 9_200 + i * 100);
  assert.equal(admit({ nowMs: 10_000, recentEventsMs: recent }).admission, 'drop-flood');
});

test('a sustained flood stays blocked rather than leaking one event per window', () => {
  // Flood-dropped events must REMAIN in the window. If they were discarded the
  // window would drain and let a press through on every cycle, which is exactly
  // the starvation this guard exists to stop.
  let recent = Array.from({ length: 8 }, (_, i) => 9_200 + i * 100);
  for (let i = 0; i < 20; i++) {
    const r = admit({ nowMs: 10_000 + i * 10, recentEventsMs: recent });
    assert.equal(r.admission, 'drop-flood', `flood event ${i}`);
    recent = r.recentEventsMs;
  }
});

test('a same-source repeat faster than a human is dropped as bounce', () => {
  const r = admit({ nowMs: 10_050, lastEmitBySource: { hid: 10_000 } });
  assert.equal(r.admission, 'drop-bounce');
});

test('bounce-dropped events do not push the same-source floor forward', () => {
  // The floor is compared against the last ACCEPTED emit. If a bounce moved it,
  // a chattering device would lock its own source out indefinitely — including
  // the user's real presses on that source.
  const r = admit({ nowMs: 10_050, lastEmitBySource: { hid: 10_000 } });
  assert.equal(r.admission, 'drop-bounce');
  // Caller only records accepted emits, so at 10_130 the floor is still 10_000
  // and 130ms has genuinely elapsed.
  const later = admit({ nowMs: 10_130, lastEmitBySource: { hid: 10_000 } });
  assert.equal(later.admission, 'accept');
});

test('one physical press seen on two sources counts once', () => {
  // Cheap shutters emit both a HID key and a volume change ~10-80ms apart.
  // Counting both produced phantom double-clicks that advanced the hole.
  const r = admit({ source: 'volume', nowMs: 10_040, lastEmitBySource: { hid: 10_000 } });
  assert.equal(r.admission, 'drop-dup');
  assert.equal(r.suppressedBy, 'hid');
});

test('cross-source dedup does not suppress genuinely separate presses', () => {
  const r = admit({ source: 'volume', nowMs: 10_300, lastEmitBySource: { hid: 10_000 } });
  assert.equal(r.admission, 'accept');
});

test('dedup attributes to the most recent other source', () => {
  const r = admit({
    source: 'hid',
    nowMs: 10_050,
    lastEmitBySource: { volume: 10_000, remote: 9_000 },
  });
  assert.equal(r.admission, 'drop-dup');
  assert.equal(r.suppressedBy, 'volume');
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

test('rate limiting is decided before bounce and dedup', () => {
  // The rate check is the one guarding against an unbounded external source, so
  // it must not be reachable only after the cheaper checks pass.
  const recent = Array.from({ length: 8 }, (_, i) => 9_200 + i * 100);
  const r = admit({ nowMs: 10_000, recentEventsMs: recent, lastEmitBySource: { hid: 9_990 } });
  assert.equal(r.admission, 'drop-flood');
});

test('every outcome still returns the pruned window with this event recorded', () => {
  // The caller assigns this back unconditionally; a branch that forgot it would
  // silently disable rate limiting from that point on.
  for (const args of [
    {},
    { nowMs: 10_050, lastEmitBySource: { hid: 10_000 } },
    { source: 'volume', nowMs: 10_040, lastEmitBySource: { hid: 10_000 } },
    { nowMs: 10_000, recentEventsMs: Array.from({ length: 8 }, (_, i) => 9_200 + i * 100) },
  ]) {
    const r = admit(args);
    assert.ok(r.recentEventsMs.length > 0, `empty window for ${JSON.stringify(args)}`);
    assert.ok(
      r.recentEventsMs.includes(args.nowMs ?? 10_000),
      `this event missing from window for ${JSON.stringify(args)}`
    );
  }
});
