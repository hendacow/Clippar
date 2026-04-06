export type BLEConnectionState = 'scanning' | 'connecting' | 'connected' | 'disconnected';

export interface BLEDevice {
  id: string;
  name: string | null;
  rssi: number | null;
}

export type BLEEvent = 'press' | 'connected' | 'disconnected';
