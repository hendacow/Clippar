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
let useKeyEvent: any = null;
let keyEventAvailable = false;
try {
  if (Platform.OS !== 'web') {
    const mod = require('expo-key-event');
    useKeyEvent = mod.useKeyEvent;
    keyEventAvailable = true;
  }
} catch {
  // Not installed
}

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

export interface ShutterState {
  connected: boolean;
  source: ShutterSource;
  statusLabel: string;
  onPress: (callback: () => void) => () => void;
  simulatePress: () => void;
  ble: ReturnType<typeof useBLE>;
}

// Shutter key codes we listen for
const SHUTTER_KEYS = new Set(['AudioVolumeUp', 'VolumeUp', 'Enter', ' ']);

export function useShutter(): ShutterState {
  const ble = useBLE();
  const listenersRef = useRef<Set<() => void>>(new Set());
  const [lastPressTime, setLastPressTime] = useState(0);
  const [activeSource, setActiveSource] = useState<ShutterSource>('none');
  const activeSourceRef = useRef<ShutterSource>('none');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // --- Helper: emit press to all listeners ---
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

    listenersRef.current.forEach((cb) => cb());
  }, []);

  // --- Method 1: expo-key-event ---
  // useKeyEvent is a hook, so we always call it (or a stub) to satisfy rules of hooks
  const keyEventResult = keyEventAvailable ? useKeyEvent() : { keyEvent: null };
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

  // --- Unified onPress ---
  const onPress = useCallback(
    (callback: () => void): (() => void) => {
      // Register with BLE (fallback for custom BLE peripherals)
      const unsubBle = ble.onPress(callback);

      // Register with our local listeners (key-event + volume)
      listenersRef.current.add(callback);

      return () => {
        unsubBle();
        listenersRef.current.delete(callback);
      };
    },
    [ble.onPress]
  );

  const simulatePress = useCallback(() => {
    emitPress('simulated');
  }, [emitPress]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return {
    connected,
    source,
    statusLabel,
    onPress,
    simulatePress,
    ble,
  };
}
