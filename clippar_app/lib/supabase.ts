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

      // In-memory mirror of the latest value written this process. It exists
      // ONLY to answer a transient SecureStore *read* failure (the Keychain
      // "User interaction is not allowed" window we used to fall back to disk
      // for) without ever persisting the Supabase session — which contains the
      // long-lived refresh token — to unencrypted on-disk AsyncStorage. The
      // cache lives for the process lifetime and is cleared on removeItem, so
      // no cleartext secret survives on disk or across launches. SecureStore
      // (Keychain) remains the sole at-rest store.
      const memoryCache = new Map<string, string>();

      return {
        getItem: async (key: string): Promise<string | null> => {
          try {
            const value = await SecureStore.getItemAsync(key);
            if (value !== null) {
              memoryCache.set(key, value);
              return value;
            }
            // SecureStore succeeded but has no value: return the in-memory
            // copy if we hold one (covers a racey read during this session),
            // else a genuine "no session".
            return memoryCache.has(key) ? memoryCache.get(key)! : null;
          } catch {
            // Keychain unavailable (e.g. interaction-not-allowed) — serve the
            // in-memory copy instead of throwing out of the whole call stack.
            return memoryCache.has(key) ? memoryCache.get(key)! : null;
          }
        },
        setItem: async (key: string, value: string): Promise<void> => {
          memoryCache.set(key, value);
          try {
            await SecureStore.setItemAsync(key, value);
          } catch {
            // Keychain write failed; the in-memory copy above still lets reads
            // succeed this session without writing plaintext to disk.
          }
        },
        removeItem: async (key: string): Promise<void> => {
          memoryCache.delete(key);
          try { await SecureStore.deleteItemAsync(key); } catch {}
        },
      };
    })();

// Database types will be generated from Supabase CLI after schema deployment
console.log('[Boot] Supabase URL:', config.supabase.url);
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
