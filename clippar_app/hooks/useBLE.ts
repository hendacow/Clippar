import { useEffect, useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import type { BLEConnectionState, BLEDevice } from '@/types/ble';

// Safe SecureStore access — won't crash on web
const secureStore =
  Platform.OS !== 'web'
    ? (require('expo-secure-store') as typeof import('expo-secure-store'))
    : null;

// BLE Manager class — resolved at import, but NEVER instantiated here.
//
// This used to run `new blePlx.BleManager(); testManager.destroy();` at module
// scope as a "is the native module linked?" probe. That constructor allocates
// a CBCentralManager, which on iOS 13+ is exactly what raises the
// NSBluetoothAlwaysUsageDescription TCC prompt. expo-router eagerly requires
// every file under app/, and app/(tabs)/record.tsx → hooks/useShutter.ts →
// here, so the probe ran at COLD START: a Bluetooth permission dialog before
// login, before onboarding, with nothing on screen to justify it — and a
// well-known App Review rejection (spec 5.7 BLE permission overreach, 6.5
// "scan only while pairing").
//
// Nothing is allocated now until the user explicitly taps Scan or connects on
// app/profile/bluetooth.tsx (see ensureManager below). Presence of the class is
// checked without constructing it; a missing native module (Expo Go) surfaces
// as a constructor throw inside ensureManager instead, which is handled there.
let BleManager: any = null;
let bleModuleLoaded = false;
try {
  if (Platform.OS !== 'web') {
    BleManager = require('react-native-ble-plx').BleManager;
    bleModuleLoaded = typeof BleManager === 'function';
  }
} catch {
  // Native module not available (Expo Go or web)
}

const HID_SERVICE_UUID = '00001812-0000-1000-8000-00805f9b34fb';
const HID_REPORT_CHAR_UUID = '00002a4d-0000-1000-8000-00805f9b34fb';
const SCAN_TIMEOUT_MS = 15_000;
const STORED_DEVICE_KEY = 'ble_device_id';

type PressCallback = () => void;

export function useBLE() {
  const [connectionState, setConnectionState] = useState<BLEConnectionState>('disconnected');
  const [devices, setDevices] = useState<BLEDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BLEDevice | null>(null);
  const pressCallbacks = useRef<Set<PressCallback>>(new Set());
  const managerRef = useRef<any>(null);
  const deviceRef = useRef<any>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const maxRetries = 5;

  /**
   * Allocate the CBCentralManager — and with it the iOS Bluetooth prompt —
   * ONLY on an explicit user action. Called from startScan and
   * connectToDevice, both of which are reachable only from the pairing screen
   * (app/profile/bluetooth.tsx). Returns null when BLE is unusable, so every
   * caller degrades to a no-op instead of throwing.
   *
   * This replaces a mount effect that constructed a manager for every useBLE()
   * in the tree. The construction itself is the permission ask; deferring it
   * is the whole control.
   */
  const ensureManager = useCallback((): any | null => {
    if (managerRef.current) return managerRef.current;
    if (!bleModuleLoaded) return null;
    try {
      managerRef.current = new BleManager();
    } catch {
      // Native module not linked (Expo Go) — the constructor is where that
      // shows up now that there is no module-scope probe.
      managerRef.current = null;
    }
    return managerRef.current;
  }, []);

  // Tear down whatever was activated, on unmount only.
  useEffect(() => {
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, []);

  const onPress = useCallback((callback: PressCallback) => {
    pressCallbacks.current.add(callback);
    return () => {
      pressCallbacks.current.delete(callback);
    };
  }, []);

  const emitPress = useCallback(() => {
    pressCallbacks.current.forEach((cb) => cb());
  }, []);

  const subscribeToHID = useCallback(
    async (nativeDevice: any) => {
      try {
        const device = await nativeDevice.discoverAllServicesAndCharacteristics();
        const services = await device.services();

        for (const service of services) {
          const characteristics = await service.characteristics();
          for (const char of characteristics) {
            if (
              char.isNotifiable &&
              (service.uuid.toLowerCase().includes('1812') ||
                char.uuid.toLowerCase().includes('2a4d'))
            ) {
              char.monitor((error: any, characteristic: any) => {
                if (error) return;
                if (characteristic?.value) {
                  emitPress();
                }
              });
            }
          }
        }

        device
          .monitorCharacteristicForService(
            HID_SERVICE_UUID,
            HID_REPORT_CHAR_UUID,
            (error: any, characteristic: any) => {
              if (error) return;
              if (characteristic?.value) {
                emitPress();
              }
            }
          )
          .catch(() => {
            // HID report characteristic may not exist on all devices
          });
      } catch {
        // Service discovery failed
      }
    },
    [emitPress]
  );

  const startScan = useCallback(async () => {
    // First activation point: the user tapped "Scan for Devices". This is the
    // earliest moment a CBCentralManager (and therefore the iOS Bluetooth
    // prompt) may exist.
    const manager = ensureManager();
    if (!manager) {
      console.log('[BLE] Scanning not available (Expo Go or web)');
      return;
    }

    setConnectionState('scanning');
    setDevices([]);

    const seen = new Set<string>();

    manager.startDeviceScan(
      null,
      { allowDuplicates: false },
      (error: any, device: any) => {
        if (error) {
          console.log('[BLE] Scan error:', error.message);
          setConnectionState('disconnected');
          return;
        }
        if (!device || seen.has(device.id)) return;
        if (!device.name && !device.localName) return;

        seen.add(device.id);
        const bleDevice: BLEDevice = {
          id: device.id,
          name: device.localName ?? device.name,
          rssi: device.rssi,
        };
        setDevices((prev) => [...prev, bleDevice]);
      }
    );

    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      managerRef.current?.stopDeviceScan();
      setConnectionState((prev) => (prev === 'scanning' ? 'disconnected' : prev));
    }, SCAN_TIMEOUT_MS);
  }, [ensureManager]);

  const stopScan = useCallback(() => {
    managerRef.current?.stopDeviceScan();
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setConnectionState('disconnected');
  }, []);

  const connectToDevice = useCallback(
    async (device: BLEDevice) => {
      // Second activation point: the user tapped a discovered device on the
      // pairing screen. Normally the manager already exists (they scanned to
      // get here) — ensureManager keeps this path honest if it doesn't.
      const manager = ensureManager();
      if (!manager) return;

      manager.stopDeviceScan();
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
        scanTimerRef.current = null;
      }

      setConnectionState('connecting');
      try {
        const nativeDevice = await manager.connectToDevice(device.id, {
          autoConnect: true,
          requestMTU: 256,
        });

        deviceRef.current = nativeDevice;

        nativeDevice.onDisconnected(() => {
          setConnectedDevice(null);
          setConnectionState('disconnected');
          deviceRef.current = null;
          attemptReconnect();
        });

        await subscribeToHID(nativeDevice);
        await secureStore?.setItemAsync(STORED_DEVICE_KEY, device.id);

        setConnectedDevice(device);
        setConnectionState('connected');
        retryCount.current = 0;
      } catch (error) {
        console.log('[BLE] Connection failed:', (error as Error).message);
        setConnectionState('disconnected');
        deviceRef.current = null;
      }
    },
    [subscribeToHID, ensureManager]
  );

  const disconnect = useCallback(async () => {
    try {
      if (deviceRef.current) {
        await deviceRef.current.cancelConnection();
      }
    } catch {
      // Already disconnected
    }
    deviceRef.current = null;
    setConnectedDevice(null);
    setConnectionState('disconnected');
    retryCount.current = 0;
  }, []);

  // Reconnect after a DROP inside an already-active session. Deliberately uses
  // managerRef directly and never ensureManager: if no manager exists, the
  // user is not in the pairing flow and we must not allocate one (which is
  // what would make the app connect to a SecureStore-persisted device — with
  // five exponential-backoff retries — outside any pairing screen, and burn
  // battery doing it mid-round).
  const attemptReconnect = useCallback(async () => {
    if (!managerRef.current || retryCount.current >= maxRetries) return;

    const storedDeviceId = await secureStore?.getItemAsync(STORED_DEVICE_KEY);
    if (!storedDeviceId) return;

    retryCount.current += 1;
    const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30000);

    setTimeout(async () => {
      try {
        setConnectionState('connecting');
        const nativeDevice = await managerRef.current.connectToDevice(storedDeviceId, {
          autoConnect: true,
          requestMTU: 256,
        });

        deviceRef.current = nativeDevice;

        nativeDevice.onDisconnected(() => {
          setConnectedDevice(null);
          setConnectionState('disconnected');
          deviceRef.current = null;
          attemptReconnect();
        });

        await subscribeToHID(nativeDevice);

        setConnectedDevice({
          id: storedDeviceId,
          name: nativeDevice.localName ?? nativeDevice.name ?? 'Clicker',
          rssi: nativeDevice.rssi,
        });
        setConnectionState('connected');
        retryCount.current = 0;
      } catch {
        setConnectionState('disconnected');
        attemptReconnect();
      }
    }, delay);
  }, [subscribeToHID]);

  // NO auto-reconnect on mount.
  //
  // This used to register onStateChange(..., true) — which fires immediately —
  // and reconnect to the stored device id the moment Bluetooth reported
  // PoweredOn, for every mounted useBLE(). Combined with the module-scope
  // manager that meant the app both prompted for Bluetooth and started
  // connecting at launch, outside any pairing flow (spec 6.5: scan only while
  // pairing). Reconnection now happens only from onDisconnected inside a
  // session the user started on the pairing screen.
  //
  // Nothing is lost for the shipped hardware: iOS blocks BLE GATT access to
  // paired HID devices, so off-the-shelf shutters never used this path at all
  // (see the header of hooks/useShutter.ts) — they arrive as key/volume events.

  const simulatePress = useCallback(() => {
    emitPress();
  }, [emitPress]);

  return {
    connectionState,
    devices,
    connectedDevice,
    startScan,
    stopScan,
    connectToDevice,
    disconnect,
    onPress,
    simulatePress,
  };
}
