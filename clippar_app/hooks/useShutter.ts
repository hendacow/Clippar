/**
 * useShutter — Unified hook for Bluetooth shutter remote control.
 *
 * Cheap Bluetooth shutters (AB Shutter3, etc.) pair at the OS level as HID
 * keyboards and send Volume Up (iOS) or Enter + Volume Up (Android).
 *
 * iOS blocks BLE GATT access to paired HID devices, so the BLE approach in
 * useBLE.ts will NOT work for off-the-shelf shutters. Instead we intercept
 * hardware key events and volume changes at the app level.
 *
 * Detection methods (priority order):
 * 1. expo-key-event — captures HID key events (Enter, VolumeUp) cross-platform
 * 2. react-native-volume-manager — detects volume changes, suppresses HUD
 * 3. useBLE — fallback for custom BLE GATT peripherals (not off-the-shelf shutters)
 *
 * All three require a dev build. In Expo Go, only the simulated press works.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useBLE } from '@/hooks/useBLE';
import { classifyVolumeEvent } from '@/lib/liveRecordingLogic';
import { admitShutterPress, shouldRescheduleFlush } from '@/lib/shutterGuards';

// Try loading expo-key-event (requires dev build + config plugin)
let realUseKeyEvent: any = null;
let keyEventAvailable = false;
try {
  if (Platform.OS !== 'web') {
    const mod = require('expo-key-event');
    realUseKeyEvent = mod.useKeyEvent;
    keyEventAvailable = true;
  }
} catch {
  // Not installed
}

// Stable hook wrapper that always calls a hook-like function in the same
// position, whether the native module is available or not. This preserves
// React's hook ordering invariant (Rules of Hooks).
const noopKeyEvent = () => ({ keyEvent: null });
const useStableKeyEvent: () => { keyEvent: any } =
  keyEventAvailable && realUseKeyEvent ? realUseKeyEvent : noopKeyEvent;

// Try loading react-native-volume-manager (requires dev build)
let VolumeManager: any = null;
let volumeAvailable = false;
try {
  if (Platform.OS !== 'web') {
    VolumeManager = require('react-native-volume-manager').VolumeManager;
    volumeAvailable = true;
  }
} catch {
  // Not installed
}

export type ShutterSource = 'key-event' | 'volume' | 'ble' | 'simulated' | 'none';

export type ShutterClickEvent = { count: 1 | 2 | 3 };

export interface ShutterState {
  connected: boolean;
  source: ShutterSource;
  statusLabel: string;
  /**
   * Fires immediately on every physical press, with no debounce. Use this
   * when latency matters more than knowing the gesture (e.g., emitting
   * haptic feedback the moment the user presses, or stopping a clip
   * already in progress). Multiple presses fire this multiple times.
   */
  onPress: (callback: () => void) => () => void;
  /**
   * Debounced handler that fires once per gesture after a short quiet
   * window, with the total click count (1, 2, or 3). Use when you need
   * to distinguish single from double from triple click — e.g., mapping
   * 1 click → start/stop shot, 2 → next hole, 3 → quick penalty. The
   * cost is a ~CLICK_WINDOW_MS delay before the action fires.
   */
  onClick: (callback: (event: ShutterClickEvent) => void) => () => void;
  /**
   * Cancel the pending click-resolution timer and reset the count. Call
   * from an `onPress` listener when you've handled the press immediately
   * and don't want the debounced `onClick` to fire later. Example: a
   * recording-screen press that means "stop recording right now" — we
   * stop on the press and call this so the 1s onClick window doesn't
   * resolve into "start recording again".
   */
  clearPendingClicks: () => void;
  /**
   * Re-arm the volume grace window (VOLUME_GRACE_MS). The window is armed
   * automatically at mount and on app foreground, but iOS ALSO emits
   * phantom volume notifications when the audio session (re)activates
   * mid-app — most importantly when the CameraView mounts at round start
   * (the patched expo-camera asserts .playAndRecord + setActive there) and
   * when returning from the editor (PreviewPlayer flips the session to
   * .playback and back). Callers should arm this at those moments so the
   * activation noise can't be counted as a press and phantom-start a
   * recording.
   */
  armVolumeGrace: () => void;
  simulatePress: () => void;
  ble: ReturnType<typeof useBLE>;
}

// Shutter key codes we listen for
const SHUTTER_KEYS = new Set(['AudioVolumeUp', 'VolumeUp', 'Enter', ' ']);

// How long to wait after the last press before deciding a gesture is done.
// 1000ms — generous enough that a slow / nervous double or triple click is
// never misread as separate gestures. The downside is a 1s latency on
// single-click actions, but for golf this is invisible: pressing to start
// a shot is followed by 5–20s of walking up to the ball anyway, and
// pressing to stop happens after the swing has clearly finished. User
// testing settled on this number after 300ms and 400ms both clipped real
// gestures sometimes.
// Exported for the cinematic onboarding tutorial: its fake clicker resolves
// taps with THIS window so the timing golfers learn in the theatre is the
// timing the real clicker demands. If this constant moves, the tutorial
// moves with it — that coupling is the point.
export const CLICK_WINDOW_MS = 1000;

// Many cheap shutters fire BOTH a key-event (HID) AND a volume change for
// the SAME physical press, with the two events landing within a few tens of
// milliseconds. We use this window to dedupe — if a press from one source
// lands within DUP_WINDOW_MS of a press from another source, we treat them
// as the same physical press and only count it once.
const DUP_WINDOW_MS = 120;

// We cap the counted clicks at this number; further presses in the same
// window collapse to a triple. Any reasonable golf-mid-round action maps
// to 1, 2, or 3 clicks and we don't want to encourage four-click chords.
const MAX_CLICKS = 3;

// --- Rate limiting (control BLE-002) ------------------------------------
// DUP_WINDOW_MS above is CROSS-source only — by design it never suppresses two
// events from the SAME source, which left the pipeline with no floor at all.
// A shutter is a plain HID keyboard: we can't identify it, can't tell it from
// any other paired keyboard in range, and can't stop it autorepeating. See
// lib/shutterGuards.ts for the full rationale; the numbers:
//   - 120ms same-source floor: well under a human double-click (150-400ms),
//     well above any mechanical bounce.
//   - 8 events per rolling second across ALL sources: no human gesture gets
//     close (a triple-click is 3), so anything above it is autorepeat or a
//     hostile flood and is dropped outright.
const MIN_SAME_SOURCE_INTERVAL_MS = 120;
const RATE_WINDOW_MS = 1000;
const RATE_MAX_EVENTS = 8;

// Minimum spacing between volume re-centers issued for DROPPED events. An
// accepted press always re-centers immediately; a flood must not buy a
// VolumeManager.setVolume round-trip per event, but we still have to
// re-center periodically or the system volume saturates at 1.0 and the
// shutter stops emitting change events entirely.
const DROPPED_RESET_THROTTLE_MS = 250;

// Verbose console logging gated to dev builds. Set to false in production
// to keep the JS bridge quiet during recording.
const DEBUG = __DEV__;

const slog = (label: string, data?: Record<string, unknown>) => {
  if (!DEBUG) return;
  // Use a stable timestamp + label prefix so events sort and grep cleanly
  // in the Metro log stream.
  console.log(`[shutter ${Date.now() % 100000}] ${label}`, data ?? '');
};

export interface UseShutterOptions {
  /**
   * Is the caller an ARMED capture surface right now (round in progress, this
   * screen focused, no blocking overlay)? Gates the volume channel, which is
   * the only part of this hook that mutates GLOBAL device state.
   *
   * Why this exists: the volume effect calls showNativeVolumeUI({enabled:
   * false}) and pins the system volume to 0.5 on every event, and its cleanup
   * (which restores the HUD) only ran on unmount of the record screen. Bottom
   * tabs stay mounted after first focus and the editor is pushed ON TOP of the
   * record screen, so after one visit to Record the user could no longer
   * adjust or mute the volume ANYWHERE in the app — including while previewing
   * their own reel with music. The action gating was correct; the global side
   * effect simply outlived the capture surface (spec 6.5: the capture state
   * machine must be explicit and bounded).
   *
   * Defaults to true so an omitted option is the historical behaviour rather
   * than a silently dead clicker.
   */
  armed?: boolean;
}

export function useShutter({ armed = true }: UseShutterOptions = {}): ShutterState {
  // Non-activating: useBLE no longer constructs a CBCentralManager until an
  // explicit scan/connect, so this call cannot raise the iOS Bluetooth prompt.
  // The BLE GATT path can't drive off-the-shelf HID shutters anyway (see the
  // file header) — it exists only for custom peripherals paired from
  // app/profile/bluetooth.tsx.
  const ble = useBLE();
  // Immediate-press listeners: fire on every physical press, no debounce.
  const listenersRef = useRef<Set<() => void>>(new Set());
  // Debounced-click listeners: fire once per gesture with the total count.
  const clickListenersRef = useRef<Set<(e: ShutterClickEvent) => void>>(new Set());
  // Rolling count of recent presses, flushed to clickListenersRef after
  // CLICK_WINDOW_MS of quiet. Refs because we mutate from inside callbacks.
  const clickCountRef = useRef(0);
  const clickFlushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Per-source last-emit timestamps. We use these to dedupe events from
  // different sources that fire for the SAME physical press. Cheap shutters
  // commonly emit both a HID key event and a volume change within ~10–80ms;
  // counting both as separate presses produces phantom "double clicks" that
  // randomly advance the hole. The fix is a time-windowed cross-source
  // suppression — see emitPress.
  const lastEmitBySourceRef = useRef<Partial<Record<ShutterSource, number>>>({});
  // Rolling window of every event SEEN (accepted or flood-dropped) in the last
  // RATE_WINDOW_MS, for the rate limiter. A ref, not state — see the note on
  // the removed lastPressTime state below.
  const recentEventsRef = useRef<number[]>([]);

  // NOTE: there used to be a `lastPressTime` state here, written on every
  // single press and read by nobody. Each write re-rendered RecordScreen — a
  // ~1900-line component hosting a live CameraView — on the JS thread while
  // recordAsync was running, once per event, with no rate limit upstream.
  // activeSource below IS read (it drives the "Clicker connected" badge), so it
  // stays state, but it is only written when the value actually changes.
  const [activeSource, setActiveSource] = useState<ShutterSource>('none');
  const activeSourceRef = useRef<ShutterSource>('none');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // --- Helper: emit press to all listeners ---
  // Every physical press from every source (key-event, volume, ble,
  // simulated) flows through here. It does four things:
  //   1. Admission control (lib/shutterGuards.admitShutterPress) — rate limit,
  //      same-source bounce floor, cross-source dedup. A shutter is an
  //      unauthenticated HID keyboard; this is the only place its event rate
  //      is bounded.
  //   2. Bumps the source / activity timestamp.
  //   3. Feeds the click counter; the counter flushes to `onClick`
  //      listeners CLICK_WINDOW_MS after the last press in a gesture.
  //   4. Fires immediate `onPress` listeners with no delay.
  //
  // Returns true when the event was accepted as a press, so the volume caller
  // can decide whether to pay a setVolume round-trip for it.
  const emitPress = useCallback((source: ShutterSource): boolean => {
    const now = Date.now();

    const verdict = admitShutterPress({
      source,
      nowMs: now,
      lastEmitBySource: lastEmitBySourceRef.current,
      recentEventsMs: recentEventsRef.current,
      minSameSourceIntervalMs: MIN_SAME_SOURCE_INTERVAL_MS,
      dupWindowMs: DUP_WINDOW_MS,
      rateWindowMs: RATE_WINDOW_MS,
      rateMaxEvents: RATE_MAX_EVENTS,
    });
    recentEventsRef.current = verdict.recentEventsMs;

    if (verdict.admission === 'drop-flood') {
      // Fail CLOSED. A flood means we cannot tell which events (if any) are
      // the golfer's, so we drop them AND cancel whatever gesture is already
      // accumulating. Otherwise the tail of a flood resolves into a 3-click
      // "water hazard" penalty — a real stroke written to SQLite and pushed to
      // the server — and the pending timer starves the user's own press.
      // No action at all is the only safe answer to untrusted input we can't
      // attribute (spec 5.7 replay/button flood, control BLE-002).
      if (clickFlushTimerRef.current) {
        clearTimeout(clickFlushTimerRef.current);
        clickFlushTimerRef.current = undefined;
      }
      clickCountRef.current = 0;
      slog('emit DROPPED (rate limit — input flood)', {
        source,
        eventsInWindow: verdict.recentEventsMs.length,
        windowMs: RATE_WINDOW_MS,
      });
      return false;
    }

    if (verdict.admission === 'drop-bounce') {
      // Same source repeating faster than a human can press. Deliberately do
      // NOT stamp lastEmitBySource here: if bounce-dropped events pushed the
      // floor forward, a sustained autorepeat would lock this source out
      // permanently, including the golfer's own presses.
      slog('emit SUPPRESSED (same-source bounce)', {
        source,
        minIntervalMs: MIN_SAME_SOURCE_INTERVAL_MS,
      });
      return false;
    }

    if (verdict.admission === 'drop-dup') {
      slog('emit SUPPRESSED (cross-source dup)', {
        source,
        suppressedBy: verdict.suppressedBy,
        dupWindowMs: DUP_WINDOW_MS,
      });
      // Still record this source's timestamp so subsequent dedup decisions
      // see it — otherwise the SECOND of three duplicates would slip
      // through if it's far from the first but close to nothing.
      lastEmitBySourceRef.current[source] = now;
      return false;
    }

    lastEmitBySourceRef.current[source] = now;

    // Only write state when the value actually changes — this used to fire on
    // every event and re-render the live-camera screen with it.
    if (activeSourceRef.current !== source) setActiveSource(source);
    activeSourceRef.current = source;

    // Reset "connected" after 60s of inactivity
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setActiveSource('none');
      activeSourceRef.current = 'none';
    }, 60_000);

    // (3) click counter + flush timer. Set up BEFORE firing the immediate
    // listeners so a listener can call clearPendingClicks() to cancel the
    // flush in-flight (e.g. "stop recording now, don't trigger another
    // onClick 1s later that would start a new recording").
    //
    // The reschedule is conditional: once the count is capped at MAX_CLICKS
    // the gesture can't say anything new, so re-arming on every further press
    // would let a burst postpone resolution indefinitely.
    const reschedule = shouldRescheduleFlush({
      clickCountBefore: clickCountRef.current,
      hasPendingTimer: clickFlushTimerRef.current !== undefined,
      maxClicks: MAX_CLICKS,
    });
    clickCountRef.current = Math.min(clickCountRef.current + 1, MAX_CLICKS);
    slog('emit ACCEPTED', {
      source,
      count: clickCountRef.current,
      immediateListeners: listenersRef.current.size,
      clickListeners: clickListenersRef.current.size,
    });
    if (reschedule) {
      if (clickFlushTimerRef.current) clearTimeout(clickFlushTimerRef.current);
      clickFlushTimerRef.current = setTimeout(() => {
        const count = clickCountRef.current as 1 | 2 | 3;
        slog('click FLUSH', {
          count,
          listenerCount: clickListenersRef.current.size,
        });
        clickCountRef.current = 0;
        clickFlushTimerRef.current = undefined;
        clickListenersRef.current.forEach((cb) => cb({ count }));
      }, CLICK_WINDOW_MS);
    }

    // (4) immediate listeners. Fire AFTER (3) so listeners that want to
    // short-circuit the gesture (via clearPendingClicks) can actually
    // cancel the flush we just scheduled.
    listenersRef.current.forEach((cb) => cb());
    return true;
  }, []);

  // --- Route BLE presses through the unified emit pipeline ---
  // Previously the BLE path bypassed emitPress and called subscriber
  // callbacks directly. That meant BLE presses never reached the click
  // counter. Now everything funnels through emitPress so click counting
  // works regardless of input source.
  useEffect(() => {
    return ble.onPress(() => {
      slog('source[ble] press');
      emitPress('ble');
    });
  }, [ble.onPress, emitPress]);

  // --- Method 1: expo-key-event ---
  // Always call the wrapper hook unconditionally — it's either the real hook
  // or a stable no-op, selected at module load.  This is the only way to
  // respect the Rules of Hooks (consistent hook order on every render).
  const keyEventResult = useStableKeyEvent();
  const keyEvent = keyEventResult?.keyEvent;

  useEffect(() => {
    if (!keyEvent || !keyEventAvailable) return;
    if (SHUTTER_KEYS.has(keyEvent.key)) {
      slog('source[key-event] press', { key: keyEvent.key });
      emitPress('key-event');
    } else {
      slog('source[key-event] ignored (not a shutter key)', { key: keyEvent.key });
    }
  }, [keyEvent, emitPress]);

  // --- Method 2: react-native-volume-manager ---
  // Volume changes feed the press pipeline. We have to reset the volume
  // back to the middle after each press so the shutter can keep firing
  // (otherwise it caps at 1.0 or 0.0 and stops sending change events).
  // The catch: our own setVolume call ALSO triggers the volume listener,
  // so naive code counts each press as two events.
  //
  // Previous attempt used a time-windowed flag that suppressed ANY event
  // arriving within 200ms of our setVolume call. That was wrong — a real
  // physical press arriving inside that window got silently dropped (we
  // saw it in logs at ts=99155: a 0.65 press swallowed as "own reset").
  //
  // New approach: VALUE-based suppression. We know the value we asked the
  // OS to set (RESET_TARGET = 0.5). Real shutter presses produce 0.55,
  // 0.65, or 0.7 — never exactly 0.5. So when the listener fires we just
  // compare the reported value to the reset target. If it matches within
  // a small tolerance, it's our own reset and we suppress it. Otherwise
  // it's a real press regardless of timing.
  //
  // We still timestamp the expected reset so a stale expectation can't
  // suppress a future event if the reset listener event never lands (the
  // window is generous — 600ms — because the suppression is correctness-
  // critical and the false-positive rate is essentially zero).
  const expectedResetUntilRef = useRef<number | null>(null);
  const RESET_TARGET = 0.5;
  const RESET_TOLERANCE = 0.02;
  const EXPECTED_RESET_WINDOW_MS = 600;

  // Grace window: iOS emits a volume notification when the audio session
  // (re)activates or the output route changes — e.g. the camera setting its
  // record audio mode on mount, returning from background, AirPods connecting.
  // Those report the session's CURRENT volume (any value ≠ 0.5), so the
  // value-based reset suppression above can't catch them, and one was observed
  // phantom-starting a recording ({volume: 0.25} with no press — 2026-07-03).
  // No real user press can meaningfully happen in the first moments after
  // mount/foreground, so drop volume events in that window (still re-centering
  // the volume so the press pipeline stays armed).
  const VOLUME_GRACE_MS = 1500;
  const volumeGraceUntilRef = useRef(0);

  useEffect(() => {
    if (!volumeAvailable || !VolumeManager) {
      slog('volume manager unavailable — HUD will show, no volume capture');
      return;
    }
    // ARMED-ONLY. Everything below mutates GLOBAL device state (it hides the
    // system volume HUD and pins the volume to 0.5), so it must exist only
    // while the caller is a live capture surface and be torn down the instant
    // it isn't. Previously the teardown was tied to unmount of the record
    // screen, which — bottom tabs never unmounting, and the editor being
    // pushed on TOP of the record screen — meant "the rest of the session".
    if (!armed) {
      slog('volume channel idle — screen not armed for capture');
      return;
    }

    // The user's volume before we start hijacking it, so we can hand it back
    // on disarm instead of leaving the phone pinned at our 0.5 working point.
    let userVolume: number | null = null;
    try {
      Promise.resolve(VolumeManager.getVolume?.())
        .then((v: any) => {
          const n = typeof v === 'number' ? v : v?.volume;
          if (typeof n === 'number') userVolume = n;
        })
        .catch(() => {});
    } catch {}

    // Suppress native volume HUD. If this throws or no-ops, the iOS volume
    // slider will appear on every press — log so we know.
    let hudSuppressed = false;
    try {
      VolumeManager.showNativeVolumeUI({ enabled: false });
      hudSuppressed = true;
    } catch (e) {
      slog('VolumeManager.showNativeVolumeUI threw — HUD WILL APPEAR', {
        error: (e as Error).message,
      });
    }
    slog('volume manager init', { hudSuppressed });

    // Helper: reset the system volume to the middle and arm the value-
    // based suppression so the corresponding listener fire (with value
    // ~= RESET_TARGET) doesn't count as a press.
    const resetVolumeSafely = () => {
      expectedResetUntilRef.current = Date.now() + EXPECTED_RESET_WINDOW_MS;
      try {
        VolumeManager.setVolume(RESET_TARGET, { showUI: false });
      } catch {}
    };

    // Arm the mount grace window, and re-arm it whenever the app returns to
    // the foreground (audio-session reactivation emits volume noise there too).
    volumeGraceUntilRef.current = Date.now() + VOLUME_GRACE_MS;
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        volumeGraceUntilRef.current = Date.now() + VOLUME_GRACE_MS;
      }
    });

    const subscription = VolumeManager.addVolumeListener((event: { volume?: number }) => {
      const value = event?.volume ?? -1;
      const now = Date.now();

      // Classification is pure (lib/liveRecordingLogic) so the node test
      // runner can lock it down. Two suppression layers:
      //  - grace: audio-session activation noise (mount / foreground /
      //    camera start) reporting the session's current volume;
      //  - reset value: real presses report 0.55/0.65/0.7, never exactly
      //    the 0.5 we pin the volume to — so ANY ≈0.5 event is either our
      //    own re-center landing or a session/route-change notification.
      //    Suppressing on value alone (no longer requiring a pending reset
      //    expectation) stops route changes and accessory reconnects from
      //    registering as phantom presses that stop a mid-swing clip.
      const action = classifyVolumeEvent({
        value,
        nowMs: now,
        graceUntilMs: volumeGraceUntilRef.current,
        resetTarget: RESET_TARGET,
        resetTolerance: RESET_TOLERANCE,
      });

      if (action === 'suppress-grace') {
        // Re-center so the pipeline is armed once the grace window ends.
        slog('volume change SUPPRESSED (mount/foreground grace)', { volume: value });
        resetVolumeSafely();
        return;
      }

      if (action === 'suppress-reset') {
        const expectedUntil = expectedResetUntilRef.current;
        slog('volume change SUPPRESSED (matches reset target)', {
          volume: value,
          target: RESET_TARGET,
          expecting: expectedUntil !== null && now <= expectedUntil,
        });
        // Clear a pending expectation so the next reset cycle starts clean.
        expectedResetUntilRef.current = null;
        return;
      }

      slog('source[volume] change', { volume: value });
      emitPress('volume');
      resetVolumeSafely();
    });

    // Initial reset to centre so the shutter can fire in either direction
    resetVolumeSafely();

    return () => {
      subscription?.remove?.();
      appStateSub?.remove?.();
      try { VolumeManager.showNativeVolumeUI({ enabled: true }); } catch {}
      // Hand the volume back. Without this the phone is left pinned at our
      // 0.5 working point after every round — the user's music comes back at
      // half volume and looks like the clicker "changed the volume", which is
      // the same complaint the missing dependency below caused for a different
      // reason. Captured on arm above; skipped if the read never resolved.
      if (typeof userVolume === 'number') {
        try { VolumeManager.setVolume(userVolume, { showUI: false }); } catch {}
      }
    };
    // `armed` MUST be here. It is read at the top of this effect as an early
    // return, and it is dynamic: record.tsx passes isCaptureArmed(...), which
    // is false until a round is in progress and the screen is focused. With
    // only [emitPress], the effect ran once while disarmed, bailed before
    // installing anything, and never re-ran when the round started — so for
    // the whole round there was NO volume listener, NO HUD suppression and NO
    // re-centering. Every clicker press then went straight to iOS: the volume
    // went up, the HUD appeared, and no shot was captured.
    //
    // The teardown direction matters just as much. The block above mutates
    // GLOBAL device state, and the comment at the top of the effect requires
    // it exist "only while the caller is a live capture surface". Without
    // `armed` in the deps that teardown could never fire on disarm either.
  }, [emitPress, armed]);

  // --- Determine connection status ---
  const bleConnected = ble.connectionState === 'connected';
  const shutterDetected = activeSource !== 'none';
  const connected = bleConnected || shutterDetected;

  const source: ShutterSource = shutterDetected
    ? activeSource
    : bleConnected
      ? 'ble'
      : 'none';

  const statusLabel = shutterDetected
    ? 'Shutter Connected'
    : bleConnected
      ? `${ble.connectedDevice?.name ?? 'Clicker'} Connected`
      : 'No Clicker Connected';

  // --- Unified onPress (immediate) ---
  // Subscribers are called for every physical press across every input
  // source. The BLE source no longer needs a separate registration here
  // because the useEffect above routes BLE presses through emitPress.
  const onPress = useCallback((callback: () => void): (() => void) => {
    listenersRef.current.add(callback);
    return () => {
      listenersRef.current.delete(callback);
    };
  }, []);

  // --- Debounced onClick (1/2/3-click semantics) ---
  // Fires after CLICK_WINDOW_MS of quiet with the count of presses seen
  // in that window. Add the subscriber to the same Set the emit timer
  // flushes to.
  const onClick = useCallback(
    (callback: (e: ShutterClickEvent) => void): (() => void) => {
      clickListenersRef.current.add(callback);
      return () => {
        clickListenersRef.current.delete(callback);
      };
    },
    []
  );

  // Cancel any pending click-resolution timer + zero the count. Called
  // from listeners that have handled the press immediately and don't
  // want the debounced onClick to fire later for the same gesture.
  const clearPendingClicks = useCallback(() => {
    if (clickFlushTimerRef.current) {
      clearTimeout(clickFlushTimerRef.current);
      clickFlushTimerRef.current = undefined;
    }
    if (clickCountRef.current > 0) {
      slog('click cleared by listener', { hadCount: clickCountRef.current });
    }
    clickCountRef.current = 0;
  }, []);

  // Re-arm the volume grace window on demand. The record screen calls this
  // when the CameraView mounts at round start (the native .playAndRecord
  // assertion emits an activation volume notification there — observed
  // phantom-starting a recording) and when regaining focus from the editor
  // (PreviewPlayer's session flip emits the same class of noise).
  const armVolumeGrace = useCallback(() => {
    volumeGraceUntilRef.current = Date.now() + VOLUME_GRACE_MS;
    slog('volume grace re-armed', { untilMs: VOLUME_GRACE_MS });
  }, []);

  const simulatePress = useCallback(() => {
    slog('source[simulated] press');
    emitPress('simulated');
  }, [emitPress]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (clickFlushTimerRef.current) clearTimeout(clickFlushTimerRef.current);
    };
  }, []);

  return {
    connected,
    source,
    statusLabel,
    onPress,
    onClick,
    clearPendingClicks,
    armVolumeGrace,
    simulatePress,
    ble,
  };
}
