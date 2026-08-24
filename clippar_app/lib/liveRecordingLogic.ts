/**
 * Pure decision logic for the live-recording flow (fix/live-recording-
 * hardening). Deliberately storage-free and import-free so the node test
 * runner can exercise it directly (tests/liveRecording.test.ts) — the
 * camera/shutter/round glue lives in hooks/useCamera.ts, hooks/useShutter.ts
 * and hooks/useRound.ts.
 */

/** How a volume-listener event should be handled. */
export type VolumeEventAction =
  | 'suppress-grace' // mount/foreground/camera-start noise window
  | 'suppress-reset' // our own (or a session-change echo of) the 0.5 re-center
  | 'press'; // a real physical press

/**
 * Classify a react-native-volume-manager event.
 *
 * Two suppression layers:
 *  - Grace window: iOS emits a volume notification when the audio session
 *    (re)activates or the output route changes (camera mount, foreground,
 *    AirPods connect). Those report the session's current volume and are
 *    NOT presses.
 *  - Reset value: we pin the system volume at `resetTarget` (0.5) after
 *    every press. Real shutter presses report 0.55/0.65/0.7 — never exactly
 *    0.5 — so ANY event within tolerance of the target is either our own
 *    re-center landing or a session-change notification reporting the
 *    pinned volume. Neither is a press, so we suppress on value alone
 *    (previously suppression also required a pending reset expectation,
 *    which let route-change notifications through as phantom presses).
 */
export function classifyVolumeEvent(args: {
  value: number;
  nowMs: number;
  graceUntilMs: number;
  resetTarget: number;
  resetTolerance: number;
}): VolumeEventAction {
  if (args.nowMs < args.graceUntilMs) return 'suppress-grace';
  if (Math.abs(args.value - args.resetTarget) <= args.resetTolerance) {
    return 'suppress-reset';
  }
  return 'press';
}

/** What a stop request should do. */
export type StopAction =
  | 'stop' // normal stop — finalize and save the clip
  | 'cancel' // stop the camera but DISCARD the too-short clip
  | 'ignore'; // swallow entirely (phantom volume echo shortly after start)

/** No real golf clip is under ~2s (a swing with pre/post-roll is 4s+). */
export const MIN_CLIP_DURATION_MS = 2000;

/**
 * Resolve a stop request against the elapsed recording time.
 *
 *  - Un-forced early stops (clicker/volume path) are IGNORED: phantom volume
 *    events arrive ~1–1.5s after a start (clicker bounce / volume-ramp echo)
 *    and must not kill a real recording.
 *  - Forced early stops (on-screen record button, tutorial end) CANCEL: the
 *    user unambiguously asked to stop, so the recording must actually end —
 *    but a <2s file can't finalize cleanly, so the clip is discarded rather
 *    than saved (it can't contain a shot anyway).
 */
export function resolveStopRequest(args: {
  elapsedMs: number;
  forced: boolean;
  minDurationMs?: number;
}): StopAction {
  const min = args.minDurationMs ?? MIN_CLIP_DURATION_MS;
  if (args.elapsedMs >= min) return 'stop';
  return args.forced ? 'cancel' : 'ignore';
}

/**
 * Can a new recording start right now? Blocked while a clip is actively
 * recording AND while the previous clip is still finalizing/saving —
 * calling recordAsync during the 5–10s MP4-finalize window makes the native
 * side silently no-op (the promise never settles) or reject with the
 * generic "An error occurred while recording a video".
 */
export function canStartRecording(args: {
  isRecording: boolean;
  isFinalizing: boolean;
}): boolean {
  return !args.isRecording && !args.isFinalizing;
}

/**
 * Where the round naturally ends — the LAST hole in play order, not the
 * numerically largest. 18 from 1 → 18; 9 from 10 → 18; 9 from 1 → 9; and
 * 18 from 10 (wrapping) → 9.
 */
export function lastHoleOf(holesPlayed: 9 | 18, startHole: 1 | 10): number {
  const seq = orderedHoleNumbers(holesPlayed, startHole);
  return seq[seq.length - 1];
}

/**
 * The hole played after `currentHole`, or null when `currentHole` is the last
 * hole of the round (or isn't part of it). This is THE way to advance — a
 * literal `currentHole + 1` is wrong for a wrapping round, where the hole
 * after 18 is 1.
 */
export function nextHoleAfter(
  currentHole: number,
  holesPlayed: 9 | 18,
  startHole: 1 | 10
): number | null {
  const seq = orderedHoleNumbers(holesPlayed, startHole);
  const i = seq.indexOf(currentHole);
  if (i === -1) return null;
  return i + 1 < seq.length ? seq[i + 1] : null;
}

/**
 * Index (into the full clips array) of the last clip on the given hole, or
 * -1 when the hole has no clips. Used by "Delete last shot" so the deletion
 * targets exactly one, well-defined clip.
 */
export function findLastClipIndexOnHole(
  clips: ReadonlyArray<{ holeNumber: number }>,
  currentHole: number
): number {
  for (let i = clips.length - 1; i >= 0; i--) {
    if (clips[i].holeNumber === currentHole) return i;
  }
  return -1;
}

/**
 * Where "Previous Hole" should land, or null when already on the first hole
 * played (so the caller can no-op / disable the button). Positional in play
 * order, not `currentHole - 1`: in a wrapping round (18 from the 10th tee)
 * the hole before 1 is 18, and a back-nine round can never step below 10.
 */
export function previousHoleTarget(
  currentHole: number,
  holesPlayed: 9 | 18,
  startHole: 1 | 10
): number | null {
  const seq = orderedHoleNumbers(holesPlayed, startHole);
  const i = seq.indexOf(currentHole);
  return i > 0 ? seq[i - 1] : null;
}

/**
 * The shot counter to resume on when LANDING on `holeNumber` — used both when
 * stepping back (Previous Hole) and when stepping forward onto a hole that
 * already has footage (going back then forward again).
 *
 *  - If the hole already has a committed score, resume at strokes+1. This
 *    preserves penalty strokes that aren't backed by a clip (a water-hazard
 *    penalty bumps the counter without a video), so re-ending the hole
 *    unchanged reproduces the same score.
 *  - Otherwise (a fresh hole, or a hole whose score was never committed),
 *    resume after its existing clips: clipCount+1. For a brand-new hole with
 *    no clips this is 1, matching the original forward-advance behaviour.
 */
export function resumeShotNumber(
  scores: ReadonlyArray<{ holeNumber: number; strokes: number }>,
  clips: ReadonlyArray<{ holeNumber: number }>,
  holeNumber: number
): number {
  const existing = scores.find((s) => s.holeNumber === holeNumber);
  if (existing) return Math.max(1, existing.strokes) + 1;
  const clipCount = clips.filter((c) => c.holeNumber === holeNumber).length;
  return clipCount + 1;
}

/**
 * Insert-or-replace a hole's score in the in-memory scores list, keyed by
 * holeNumber, keeping the list sorted ascending. Manual hole navigation
 * (Next / Previous Hole) can re-complete a hole that was already scored;
 * appending blindly would duplicate the entry and double-count totals. This
 * makes every score-writing branch idempotent per hole.
 */
export function upsertHoleScore<T extends { holeNumber: number }>(
  scores: ReadonlyArray<T>,
  score: T
): T[] {
  const next = scores.filter((s) => s.holeNumber !== score.holeNumber);
  next.push(score);
  next.sort((a, b) => a.holeNumber - b.holeNumber);
  return next;
}

/**
 * The real hole numbers a round covers, IN PLAY ORDER, wrapping after 18.
 * Front-9 → [1..9]; back-nine → [10..18]; full round from 1 → [1..18]; and a
 * full round teeing off on the 10th (shotgun/back-tee start) → [10..18, 1..9].
 * Recording tags each clip/score with these actual numbers, so the
 * editor/scorecard render the real card holes without any 1..N reconstruction.
 *
 * Everything positional (next hole, previous hole, round over, resume) derives
 * from THIS sequence — never from `hole + 1` arithmetic, which is wrong the
 * moment a round wraps (the hole after 18 is 1, and 1 comes after 18 in play
 * order despite being numerically smaller).
 */
export function orderedHoleNumbers(
  holesPlayed: 9 | 18,
  startHole: 1 | 10
): number[] {
  return Array.from({ length: holesPlayed }, (_, i) => ((startHole - 1 + i) % 18) + 1);
}

/**
 * Where a RESUMED round should pick up. The persisted pointer is clamped into
 * the round's real hole range, because rounds created before saveLocalRound
 * seeded `current_hole` wrote a literal 1 even for a back-nine round — which
 * resumed the user on "hole 1" (off their card, Previous Hole disabled) and
 * tagged every subsequent clip to a hole they weren't playing.
 *
 * The shot counter is only meaningful for the hole it was written on, so when
 * the hole has to be clamped we hand back null and let the caller derive it
 * from that hole's own footage/score via resumeShotNumber.
 */
export function clampRecoveredPointer(
  persistedHole: number | null | undefined,
  persistedShot: number | null | undefined,
  holesPlayed: 9 | 18,
  startHole: 1 | 10
): { hole: number; shot: number | null } {
  // Membership in the play sequence, not a numeric clamp: in a wrapping
  // round (18 from the 10th) hole 3 is legitimately mid-round despite being
  // numerically below the start, and a min/max clamp would corrupt it.
  // Legacy overshoot (a pointer past every hole on the card — the old
  // "hole 19 orphan") still lands on the LAST hole played rather than
  // yanking the golfer back to the first tee.
  const seq = orderedHoleNumbers(holesPlayed, startHole);
  let hole: number;
  if (persistedHole != null && seq.includes(persistedHole)) {
    hole = persistedHole;
  } else if (persistedHole != null && persistedHole > Math.max(...seq)) {
    hole = seq[seq.length - 1];
  } else {
    hole = startHole;
  }
  const clamped = hole !== persistedHole;
  return {
    hole,
    shot: clamped || !persistedShot ? null : Math.max(1, persistedShot),
  };
}

/**
 * Put a clip back into the round's clip list in (hole, shot) order rather than
 * appending it. Used by "Restore deleted shot": appending would place a
 * restored hole-3 shot after later holes' footage, which the editor renders in
 * array order within a hole.
 */
export function insertClipInOrder<
  T extends { holeNumber: number; shotNumber: number }
>(clips: ReadonlyArray<T>, clip: T): T[] {
  return [...clips, clip].sort((a, b) =>
    a.holeNumber !== b.holeNumber
      ? a.holeNumber - b.holeNumber
      : a.shotNumber - b.shotNumber
  );
}

/**
 * The shot counter AFTER a clip finishes saving. A clip's hole is latched when
 * recording STARTS, but the save resolves seconds later — by which time the
 * user may have changed holes. Only advance the counter when the clip belongs
 * to the hole we're standing on now; otherwise a clip for the hole they LEFT
 * would bump the counter of the hole they moved TO, drifting shot numbers out
 * of sync with the footage. Shared by useRound.recordClip and its test so the
 * exact decision that carried the bug is what's under test.
 */
export function nextShotCounterAfterClip(
  currentShot: number,
  clipHole: number,
  currentHole: number
): number {
  return clipHole === currentHole ? currentShot + 1 : currentShot;
}

/**
 * The strokes to COMMIT for the hole the user is stepping away from with
 * Previous Hole, or null to leave the hole uncommitted. Penalty strokes live
 * only in `currentShot` (a water-hazard penalty bumps it with no clip), so
 * stepping away without committing threw them away — coming back via Next
 * Hole, resumeShotNumber fell through to clipCount+1 and the penalties were
 * gone. Commit only when the hole actually saw activity (currentShot > 1);
 * otherwise we'd write a phantom 1-stroke score for a hole merely passed
 * through. Shared by useRound.previousHole and its test.
 */
export function departingHoleStrokes(currentShot: number): number | null {
  const strokes = currentShot - 1;
  return strokes >= 1 ? strokes : null;
}
