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
import { Platform } from 'react-native';
import { useBLE } from '@/hooks/useBLE';

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
const CLICK_WINDOW_MS = 1000;

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

// Verbose console logging gated to dev builds. Set to false in production
// to keep the JS bridge quiet during recording.
const DEBUG = __DEV__;

const slog = (label: string, data?: Record<string, unknown>) => {
  if (!DEBUG) return;
  // Use a stable timestamp + label prefix so events sort and grep cleanly
  // in the Metro log stream.
  console.log(`[shutter ${Date.now() % 100000}] ${label}`, data ?? '');
};

export function useShutter(): ShutterState {
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

  const [lastPressTime, setLastPressTime] = useState(0);
  const [activeSource, setActiveSource] = useState<ShutterSource>('none');
  const activeSourceRef = useRef<ShutterSource>('none');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // --- Helper: emit press to all listeners ---
  // Every physical press from every source (key-event, volume, ble,
  // simulated) flows through here. It does four things:
  //   1. Cross-source dedup — if a press from any OTHER source fired within
  //      DUP_WINDOW_MS, treat this as the same physical press and skip.
  //   2. Bumps the source / activity timestamp.
  //   3. Fires immediate `onPress` listeners with no delay.
  //   4. Feeds the click counter; the counter flushes to `onClick`
  //      listeners CLICK_WINDOW_MS after the last press in a gesture.
  const emitPress = useCallback((source: ShutterSource) => {
    const now = Date.now();

    // (1) Cross-source dedup. Find the most recent emit time across all
    //     other sources and check if it's within the dedup window.
    let mostRecentOtherSource: ShutterSource | null = null;
    let mostRecentOtherTs = 0;
    for (const [src, ts] of Object.entries(lastEmitBySourceRef.current)) {
      if (src === source || ts === undefined) continue;
      if (ts > mostRecentOtherTs) {
        mostRecentOtherTs = ts;
        mostRecentOtherSource = src as ShutterSource;
      }
    }
    const dupAge = now - mostRecentOtherTs;
    if (mostRecentOtherSource && dupAge < DUP_WINDOW_MS) {
      slog('emit SUPPRESSED (cross-source dup)', {
        source,
        suppressedBy: mostRecentOtherSource,
        ageMs: dupAge,
        dupWindowMs: DUP_WINDOW_MS,
      });
      // Still record this source's timestamp so subsequent dedup decisions
      // see it — otherwise the SECOND of three duplicates would slip
      // through if it's far from the first but close to nothing.
      lastEmitBySourceRef.current[source] = now;
      return;
    }
    lastEmitBySourceRef.current[source] = now;

    setLastPressTime(now);
    setActiveSource(source);
    activeSourceRef.current = source;

    // Reset "connected" after 60s of inactivity
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setActiveSource('none');
      activeSourceRef.current = 'none';
    }, 60_000);

    // (3) immediate listeners
    listenersRef.current.forEach((cb) => cb());

    // (4) click counter + flush timer
    clickCountRef.current = Math.min(clickCountRef.current + 1, MAX_CLICKS);
    slog('emit ACCEPTED', {
      source,
      count: clickCountRef.current,
      immediateListeners: listenersRef.current.size,
      clickListeners: clickListenersRef.current.size,
    });
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

  useEffect(() => {
    if (!volumeAvailable || !VolumeManager) {
      slog('volume manager unavailable — HUD will show, no volume capture');
      return;
    }

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

    const subscription = VolumeManager.addVolumeListener((event: { volume?: number }) => {
      const value = event?.volume ?? -1;
      const now = Date.now();
      const expectedUntil = expectedResetUntilRef.current;
      const expecting = expectedUntil !== null && now <= expectedUntil;
      const matchesReset = Math.abs(value - RESET_TARGET) <= RESET_TOLERANCE;

      if (expecting && matchesReset) {
        // This event is our own reset landing. Suppress and clear the
        // expectation so the next reset cycle starts clean.
        slog('volume change SUPPRESSED (matches expected reset)', {
          volume: value,
          target: RESET_TARGET,
        });
        expectedResetUntilRef.current = null;
        return;
      }

      // Either we weren't expecting a reset, or the value doesn't look
      // like one. Treat as a real press. (If we were expecting a reset
      // that never came, the next setVolume call will overwrite the
      // expectation so no leak.)
      if (expecting) {
        slog('source[volume] change (real, despite pending reset)', {
          volume: value,
          target: RESET_TARGET,
          delta: Math.abs(value - RESET_TARGET).toFixed(3),
        });
      } else {
        slog('source[volume] change', { volume: value });
      }
      emitPress('volume');
      resetVolumeSafely();
    });

    // Initial reset to centre so the shutter can fire in either direction
    resetVolumeSafely();

    return () => {
      subscription?.remove?.();
      try { VolumeManager.showNativeVolumeUI({ enabled: true }); } catch {}
    };
  }, [emitPress]);

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
    simulatePress,
    ble,
  };
}
