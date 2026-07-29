/**
 * Is the live-capture surface ARMED right now?
 *
 * A Bluetooth shutter is an unauthenticated HID keyboard. We cannot tell the
 * golfer's clicker from any other paired keyboard in range, so the only thing
 * standing between an external key event and a real 1080p capture is the set
 * of conditions below (spec 5.7 / control BLE-001: "accept the event only
 * inside an armed capture screen").
 *
 * Pure and dependency-free so tests/captureArming.test.ts can exercise the
 * exact predicate the record screen uses — the React glue lives in
 * app/(tabs)/record.tsx.
 */
export interface CaptureSurfaceState {
  /** round.state.status === 'in_progress' */
  roundInProgress: boolean;
  /** useIsFocused() — the editor is pushed ON TOP of the record screen, which
   *  leaves the round in progress while the user is somewhere else entirely. */
  screenFocused: boolean;
  /** The clicker tutorial overlay is mounted. */
  tutorialActive: boolean;
  /**
   * Which tutorial card is up. 'intro' renders a full-screen scrim
   * (components/record/ClickerTutorial.tsx — `styles.scrim`,
   * pointerEvents="auto") that swallows every TOUCH; 'coaching' is
   * deliberately non-blocking and is a live practice run.
   */
  tutorialPhase: 'intro' | 'coaching';
}

/**
 * The intro card is the load-bearing case. It is a modal the app tells the
 * user is inert, every on-screen control is hidden or behind the scrim, and
 * `practice` is still false — so a clicker press underneath it started a REAL
 * recording that only another clicker press could stop, and that endTutorial's
 * resetToStart then unlinked from disk with no undo entry. A scrim stops
 * fingers, not HID key events; this predicate is what stops HID key events.
 */
export function isCaptureArmed(state: CaptureSurfaceState): boolean {
  if (!state.roundInProgress || !state.screenFocused) return false;
  if (state.tutorialActive && state.tutorialPhase === 'intro') return false;
  return true;
}
