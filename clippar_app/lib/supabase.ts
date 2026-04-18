import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { config } from '@/constants/config';

// Platform-aware storage: SecureStore on native (with AsyncStorage fallback),
// localStorage on web.
//
// Why the fallback: on iOS the Keychain returns `errSecInteractionNotAllowed`
// when the device is in a state where user interaction isn't allowed (e.g.
// Face ID prompt pending, locked, or certain racey post-launch windows).
// expo-secure-store surfaces that as the JS error:
//   "Calling the 'getValueWithKeyAsync' function has failed →
//    Caused by: User interaction is not allowed."
// When it bubbles up through Supabase's auth-session code path it
// derails downstream work — most visibly our live record stop chain.
// AsyncStorage is plain disk, can't throw for the same reason, and is
// already a dep (Supabase requires it for its @supabase/supabase-js
// default adapter), so we fall back to it silently and continue.
const storageAdapter = Platform.OS === 'web'
  ? {
      getItem: (key: string) => {
        if (typeof window !== 'undefined') return window.localStorage.getItem(key);
        return null;
      },
      setItem: (key: string, value: string) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      },
      removeItem: (key: string) => {
        if (typeof window !== 'undefined') window.localStorage.removeItem(key);
      },
    }
  : (() => {
      // Dynamic import to avoid loading SecureStore on web
      const SecureStore = require('expo-secure-store');
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;

      return {
        getItem: async (key: string): Promise<string | null> => {
          try {
            return await SecureStore.getItemAsync(key);
          } catch (err) {
            // Keychain unavailable — fall back to AsyncStorage so auth
            // session read doesn't throw out of the whole call stack.
            try { return await AsyncStorage.getItem(key); } catch { return null; }
          }
        },
        setItem: async (key: string, value: string): Promise<void> => {
          try {
            await SecureStore.setItemAsync(key, value);
            // Mirror into AsyncStorage so a later SecureStore failure can still
            // read a fresh token. This costs one extra write per auth update
            // (infrequent) and protects against keychain outages mid-session.
            try { await AsyncStorage.setItem(key, value); } catch {}
          } catch {
            try { await AsyncStorage.setItem(key, value); } catch {}
          }
        },
        removeItem: async (key: string): Promise<void> => {
          try { await SecureStore.deleteItemAsync(key); } catch {}
          try { await AsyncStorage.removeItem(key); } catch {}
        },
      };
    })();

// Database types will be generated from Supabase CLI after schema deployment
export const supabase = createClient(
  config.supabase.url,
  config.supabase.anonKey,
  {
    auth: {
      storage: storageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);
