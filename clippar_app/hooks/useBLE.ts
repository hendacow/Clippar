import { useEffect, useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import type { BLEConnectionState, BLEDevice } from '@/types/ble';

// Safe SecureStore access — won't crash on web
const secureStore =
  Platform.OS !== 'web'
    ? (require('expo-secure-store') as typeof import('expo-secure-store'))
    : null;

// BLE Manager — requires native build, crashes in Expo Go
let BleManager: any = null;
let bleAvailable = false;
try {
  if (Platform.OS !== 'web') {
    const blePlx = require('react-native-ble-plx');
    // Instantiate to verify native module is linked (fails in Expo Go)
    const testManager = new blePlx.BleManager();
    testManager.destroy();
    BleManager = blePlx.BleManager;
    bleAvailable = true;
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

  // Initialize BLE manager once — only on dev builds with native modules
  useEffect(() => {
    if (!bleAvailable) return;
    managerRef.current = new BleManager();

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
    if (!bleAvailable || !managerRef.current) {
      console.log('[BLE] Scanning not available (Expo Go or web)');
      return;
    }

    setConnectionState('scanning');
    setDevices([]);

    const seen = new Set<string>();

    managerRef.current.startDeviceScan(
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
  }, []);

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
      if (!bleAvailable || !managerRef.current) return;

      managerRef.current.stopDeviceScan();
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
        scanTimerRef.current = null;
      }

      setConnectionState('connecting');
      try {
        const nativeDevice = await managerRef.current.connectToDevice(device.id, {
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
    [subscribeToHID]
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

  const attemptReconnect = useCallback(async () => {
    if (!bleAvailable || !managerRef.current || retryCount.current >= maxRetries) return;

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

  // Auto-reconnect on mount
  useEffect(() => {
    if (bleAvailable && managerRef.current) {
      const sub = managerRef.current.onStateChange((state: string) => {
        if (state === 'PoweredOn') {
          attemptReconnect();
          sub?.remove();
        }
      }, true);
      return () => sub?.remove();
    }
  }, [attemptReconnect]);

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
