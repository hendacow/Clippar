/**
 * Pure admission control for the shutter (clicker) input pipeline.
 *
 * Deliberately storage-free and import-free — same contract as
 * lib/liveRecordingLogic.ts — so the node test runner can exercise the exact
 * decisions that gate an EXTERNAL, UNAUTHENTICATED input source
 * (tests/shutterGuards.test.ts). The stateful glue lives in
 * hooks/useShutter.ts and app/(tabs)/record.tsx.
 *
 * Threat model, in one line: a cheap Bluetooth shutter pairs as a plain HID
 * keyboard. The app cannot cryptographically identify it, cannot tell it apart
 * from any other paired keyboard in range, and cannot stop it autorepeating.
 * So every press has to be treated as untrusted input and admitted only
 * (a) on an armed capture surface and (b) at a human rate.
 */

/** Where a press came from. Mirrors ShutterSource in hooks/useShutter.ts. */
export type PressSource = string;

export type PressAdmission =
  /** A real, human-rate press on a live source. */
  | 'accept'
  /** Same source repeated faster than a human can press — bounce/autorepeat. */
  | 'drop-bounce'
  /** More events in the sliding window than any human gesture produces. */
  | 'drop-flood'
  /** The same physical press already counted via a different source. */
  | 'drop-dup';

export interface PressAdmissionResult {
  admission: PressAdmission;
  /**
   * The sliding window pruned to `rateWindowMs` WITH this event recorded.
   * Flood-dropped events stay in the window on purpose: a sustained flood must
   * remain blocked for as long as it lasts, not leak one event through each
   * time the window happens to drain.
   */
  recentEventsMs: number[];
  /** For 'drop-dup': which source already counted this physical press. */
  suppressedBy?: PressSource;
}

/**
 * Decide whether a raw shutter event becomes a press.
 *
 * Checks run cheapest-and-most-hostile first:
 *
 *  1. RATE (`drop-flood`). Any paired HID device that autorepeats VolumeUp or
 *     Enter — a second shutter left switched on in the golfer's bag is enough —
 *     used to reach the gesture resolver unbounded. Each event re-armed the
 *     ~1s click-flush timer, so while the flood lasted the golfer's own press
 *     could NEVER resolve into a start or a stop (gesture starvation), every
 *     event re-rendered the full-screen live-camera component on the JS thread
 *     mid-recordAsync, and the tail of the flood resolved into a 3-click
 *     "water hazard" penalty that was persisted to SQLite and pushed to the
 *     server. Spec control BLE-002 asks for debounce AND rate limit; only the
 *     debounce existed.
 *  2. SAME-SOURCE BOUNCE (`drop-bounce`). The cross-source dedup below skips
 *     `src === source` by design, so same-source repeats had no floor at all.
 *     A floor well under a human double-click (150-400ms) and well above any
 *     mechanical bounce costs the user nothing.
 *  3. CROSS-SOURCE DUP (`drop-dup`). Pre-existing behaviour, unchanged: cheap
 *     shutters emit BOTH a HID key event and a volume change for one physical
 *     press, ~10-80ms apart, and counting both produced phantom double-clicks
 *     that randomly advanced the hole.
 *
 * `lastEmitBySource` must only record ACCEPTED (and dup-suppressed) emits — if
 * bounce-dropped events pushed it forward, a sustained flood would hold the
 * floor open indefinitely and lock that source out completely, including the
 * user's own presses.
 */
export function admitShutterPress(args: {
  source: PressSource;
  nowMs: number;
  lastEmitBySource: Readonly<Partial<Record<string, number>>>;
  recentEventsMs: readonly number[];
  minSameSourceIntervalMs: number;
  dupWindowMs: number;
  rateWindowMs: number;
  rateMaxEvents: number;
}): PressAdmissionResult {
  const {
    source,
    nowMs,
    lastEmitBySource,
    recentEventsMs,
    minSameSourceIntervalMs,
    dupWindowMs,
    rateWindowMs,
    rateMaxEvents,
  } = args;

  const windowStart = nowMs - rateWindowMs;
  const pruned = recentEventsMs.filter((t) => t > windowStart);
  pruned.push(nowMs);

  if (pruned.length > rateMaxEvents) {
    return { admission: 'drop-flood', recentEventsMs: pruned };
  }

  const lastSameSource = lastEmitBySource[source];
  if (
    lastSameSource !== undefined &&
    nowMs - lastSameSource < minSameSourceIntervalMs
  ) {
    return { admission: 'drop-bounce', recentEventsMs: pruned };
  }

  let mostRecentOtherSource: PressSource | null = null;
  let mostRecentOtherTs = 0;
  for (const [src, ts] of Object.entries(lastEmitBySource)) {
    if (src === source || ts === undefined) continue;
    if (ts > mostRecentOtherTs) {
      mostRecentOtherTs = ts;
      mostRecentOtherSource = src;
    }
  }
  if (mostRecentOtherSource && nowMs - mostRecentOtherTs < dupWindowMs) {
    return {
      admission: 'drop-dup',
      recentEventsMs: pruned,
      suppressedBy: mostRecentOtherSource,
    };
  }

  return { admission: 'accept', recentEventsMs: pruned };
}

/**
 * Should this press re-arm the click-flush timer?
 *
 * Once the count is capped at `maxClicks` the gesture cannot say anything new,
 * so re-arming the timer on every further press only lets a flood postpone
 * resolution forever. Leaving the already-scheduled timer alone guarantees the
 * gesture resolves within one click window of the capping press. The
 * `!hasPendingTimer` escape hatch means a capped count can never be left with
 * no timer at all (which would strand the count and swallow the next gesture).
 */
export function shouldRescheduleFlush(args: {
  clickCountBefore: number;
  hasPendingTimer: boolean;
  maxClicks: number;
}): boolean {
  return args.clickCountBefore < args.maxClicks || !args.hasPendingTimer;
}

/**
 * Is the record screen an ARMED capture surface right now?
 *
 * Spec 5.7 / control BLE-001: an external HID event may only act "inside an
 * armed capture screen". Three conditions, and all three carry a real bug:
 *
 *  - `roundInProgress`: no round, nothing to record.
 *  - `screenFocused`: "Review round so far" router.pushes the editor ON TOP of
 *    the record screen, so the round stays in progress while the user is in
 *    the editor. Without the focus term, volume presses used for preview
 *    playback start recordings and advance holes behind the user's back.
 *  - `blockingOverlay`: the clicker tutorial's intro card renders a
 *    full-screen scrim and both it and the record screen assert that nothing
 *    underneath can fire. That was only ever true for TOUCH. The shutter
 *    subscriptions were gated on round+focus alone, and `practice` is false
 *    during the intro phase — so a clicker press under the "inert" card
 *    started a REAL 1080p capture that no on-screen control could stop (every
 *    control is hidden while the tutorial is up), and which the practice
 *    run's resetToStart then unlinked from disk with no undo.
 */
export function isArmedCaptureSurface(args: {
  roundInProgress: boolean;
  screenFocused: boolean;
  blockingOverlay: boolean;
}): boolean {
  return args.roundInProgress && args.screenFocused && !args.blockingOverlay;
}
