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
// 400ms catches a deliberate double-click without being so long that single
// clicks feel laggy. Triple-click works within a 2× window via the natural
// rhythm of pressing 3× in succession.
const CLICK_WINDOW_MS = 400;

// We cap the counted clicks at this number; further presses in the same
// window collapse to a triple. Any reasonable golf-mid-round action maps
// to 1, 2, or 3 clicks and we don't want to encourage four-click chords.
const MAX_CLICKS = 3;

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

  const [lastPressTime, setLastPressTime] = useState(0);
  const [activeSource, setActiveSource] = useState<ShutterSource>('none');
  const activeSourceRef = useRef<ShutterSource>('none');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // --- Helper: emit press to all listeners ---
  // Every physical press from every source (key-event, volume, ble,
  // simulated) flows through here. It does three things:
  //   1. Bumps the source / activity timestamp.
  //   2. Fires immediate `onPress` listeners with no delay.
  //   3. Feeds the click counter; the counter flushes to `onClick`
  //      listeners CLICK_WINDOW_MS after the last press in a gesture.
  const emitPress = useCallback((source: ShutterSource) => {
    setLastPressTime(Date.now());
    setActiveSource(source);
    activeSourceRef.current = source;

    // Reset "connected" after 60s of inactivity
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setActiveSource('none');
      activeSourceRef.current = 'none';
    }, 60_000);

    // (2) immediate listeners
    listenersRef.current.forEach((cb) => cb());

    // (3) click counter + flush timer
    clickCountRef.current = Math.min(clickCountRef.current + 1, MAX_CLICKS);
    if (clickFlushTimerRef.current) clearTimeout(clickFlushTimerRef.current);
    clickFlushTimerRef.current = setTimeout(() => {
      const count = clickCountRef.current as 1 | 2 | 3;
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
    return ble.onPress(() => emitPress('ble'));
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
      emitPress('key-event');
    }
  }, [keyEvent, emitPress]);

  // --- Method 2: react-native-volume-manager ---
  useEffect(() => {
    if (!volumeAvailable || !VolumeManager) return;

    // Suppress native volume HUD
    try { VolumeManager.showNativeVolumeUI({ enabled: false }); } catch {}

    const subscription = VolumeManager.addVolumeListener(() => {
      // Only use volume as source if key-event didn't already fire
      // (some shutters trigger both volume change AND key event)
      if (activeSourceRef.current !== 'key-event') {
        emitPress('volume');
      }

      // Reset volume to middle so it can trigger in both directions
      try { VolumeManager.setVolume(0.5, { showUI: false }); } catch {}
    });

    // Set initial volume to middle
    try { VolumeManager.setVolume(0.5, { showUI: false }); } catch {}

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
