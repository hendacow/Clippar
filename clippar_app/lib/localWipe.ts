import { Platform } from 'react-native';
import { clearLocalDatabase } from './storage';

/**
 * Local, app-owned secure-store keys that survive a Supabase sign-out (sign-out
 * only clears the auth-session keys). On account deletion we clear these too so
 * nothing from the deleted user lingers on the device.
 *   • clippar_biometric_enabled — lib/biometrics.ts
 *   • ble_device_id             — hooks/useBLE.ts (last paired clicker)
 */
const SECURE_STORE_KEYS = ['clippar_biometric_enabled', 'ble_device_id'];

/**
 * Wipe all local state tied to the signed-in user: the SQLite database
 * (rounds/clips/scores/queue/settings) and the app's secure-store keys.
 *
 * Call this AFTER the server-side delete succeeds and BEFORE signing out, so
 * the next session — same device, possibly a different user — starts clean.
 * Best-effort and never throws: a wipe failure must not block the sign-out and
 * redirect that follow it.
 */
export async function wipeLocalUserData(): Promise<void> {
  try {
    await clearLocalDatabase();
  } catch (err) {
    console.warn('[localWipe] clearLocalDatabase failed', err);
  }

  if (Platform.OS === 'web') return;

  try {
    const SecureStore = require('expo-secure-store');
    for (const key of SECURE_STORE_KEYS) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Key absent or keychain unavailable — nothing to clean up.
      }
    }
  } catch {
    // expo-secure-store not present (web/dev) — nothing to do.
  }
}
