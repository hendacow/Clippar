import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { config } from '@/constants/config';

// Platform-aware storage: SecureStore on native, localStorage on web.
//
// Why there is a fallback at all: on iOS the Keychain returns
// `errSecInteractionNotAllowed` when the device is in a state where user
// interaction isn't allowed (e.g. Face ID prompt pending, locked, or certain
// racey post-launch windows). expo-secure-store surfaces that as the JS error:
//   "Calling the 'getValueWithKeyAsync' function has failed →
//    Caused by: User interaction is not allowed."
// When it bubbles up through Supabase's auth-session code path it
// derails downstream work — most visibly our live record stop chain.
//
// This block used to say the fallback was AsyncStorage. IT IS NOT, and must
// never become that again: AsyncStorage is unencrypted disk, and the value
// being written here is the Supabase session including the long-lived refresh
// token. The fallback is the process-lifetime in-memory mirror documented on
// `memoryCache` below, which answers a transient Keychain READ failure without
// anything reaching disk. SecureStore (Keychain) is the sole at-rest store.
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

      // In-memory mirror of the latest value written this process. It exists
      // ONLY to answer a transient SecureStore *read* failure (the Keychain
      // "User interaction is not allowed" window we used to fall back to disk
      // for) without ever persisting the Supabase session — which contains the
      // long-lived refresh token — to unencrypted on-disk AsyncStorage. The
      // cache lives for the process lifetime and is cleared on removeItem, so
      // no cleartext secret survives on disk or across launches. SecureStore
      // (Keychain) remains the sole at-rest store.
      const memoryCache = new Map<string, string>();

      // ── Keychain accessibility ──────────────────────────────────────────
      // expo-secure-store defaults to kSecAttrAccessibleWhenUnlocked, which is
      // one of the classes Apple INCLUDES in an encrypted device backup and
      // restores onto a *different* device. That makes the Supabase refresh
      // token portable: two minutes with an unlocked phone is enough to take an
      // encrypted Finder backup, restore it to an attacker's handset, and have
      // autoRefreshToken mint fresh access tokens there forever — a password
      // change doesn't necessarily kill an already-issued refresh token and the
      // app shows no session list to spot the extra device.
      // ...ThisDeviceOnly is the same unlock requirement WITHOUT the backup /
      // restore path, so the token is pinned to this handset's Secure Enclave.
      // Pass it on every call (reads/deletes ignore it in expo-secure-store's
      // lookup query, but keeping them symmetric means a future version that
      // does match on it can't orphan the item).
      const KEYCHAIN_OPTS = {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };

      // ── One-time accessibility upgrade ──────────────────────────────────
      // Passing the option only affects NEWLY ADDED items: expo-secure-store's
      // set() falls through to SecItemUpdate on errSecDuplicateItem, and that
      // update never rewrites kSecAttrAccessible (ios/SecureStoreModule.swift
      // set/update). So an install that already holds a session keeps the
      // backup-migratable flag forever unless we delete and re-add the item.
      // Do exactly that once, keyed off a marker, for the deterministic set of
      // Supabase auth keys. Every adapter method awaits `keychainReady` below
      // so GoTrue can never read a key during the delete/add window and
      // conclude the user is signed out.
      const ACCESSIBILITY_MARKER_KEY = 'clippar.secure_store_accessibility_v2';
      const supabaseAuthKeys = (): string[] => {
        const ref = config.supabase.url.match(/^https?:\/\/([^.]+)\./)?.[1];
        if (!ref) return [];
        const base = `sb-${ref}-auth-token`;
        return [
          base,
          `${base}-code-verifier`,
          // auth-js chunks oversized sessions as `<base>.0`, `.1`, …
          ...Array.from({ length: 10 }, (_, i) => `${base}.${i}`),
        ];
      };
      const upgradeKeychainAccessibility = async (): Promise<void> => {
        try {
          const done = await SecureStore.getItemAsync(
            ACCESSIBILITY_MARKER_KEY,
            KEYCHAIN_OPTS
          );
          if (done === '1') return;
          for (const key of supabaseAuthKeys()) {
            let value: string | null = null;
            try {
              value = await SecureStore.getItemAsync(key, KEYCHAIN_OPTS);
            } catch {
              continue; // Keychain busy — retry on the next cold start.
            }
            if (value === null) continue;
            try {
              await SecureStore.deleteItemAsync(key, KEYCHAIN_OPTS);
              await SecureStore.setItemAsync(key, value, KEYCHAIN_OPTS);
            } catch {
              // Never lose the session to a failed re-write: put it back under
              // whatever flags the Keychain will accept and try again later.
              try { await SecureStore.setItemAsync(key, value); } catch {}
              return;
            }
          }
          await SecureStore.setItemAsync(ACCESSIBILITY_MARKER_KEY, '1', KEYCHAIN_OPTS);
        } catch {
          // Best-effort; a failed upgrade must never block auth. It re-runs on
          // the next launch because the marker was not written.
        }
      };
      const keychainReady = upgradeKeychainAccessibility();

      // ── One-time legacy purge ───────────────────────────────────────────
      // A previous build mirrored the whole Supabase auth session (including
      // the long-lived refresh token) into unencrypted AsyncStorage. We stopped
      // writing that mirror, but the plaintext copy still sits on every existing
      // install and would survive forever otherwise. Fire-and-forget a purge of
      // the mirrored key(s) on adapter creation so the secret can't be lifted
      // off disk after this upgrade. Supabase's auth storage key is
      // `sb-<project-ref>-auth-token` (plus chunked `.0/.1…` and
      // `-code-verifier` variants); derive the ref from the configured Supabase
      // URL rather than hardcode a guess.
      const purgeLegacyAsyncStorageSession = async () => {
        try {
          const ref = config.supabase.url.match(/^https?:\/\/([^.]+)\./)?.[1];
          if (!ref) return;
          const prefix = `sb-${ref}-auth-token`;
          const keys: string[] = await AsyncStorage.getAllKeys();
          const stale = keys.filter((k) => k.startsWith(prefix));
          if (stale.length > 0) await AsyncStorage.multiRemove(stale);
        } catch {
          // Best-effort cleanup; never let a purge failure block auth.
        }
      };
      void purgeLegacyAsyncStorageSession();

      return {
        getItem: async (key: string): Promise<string | null> => {
          await keychainReady;
          try {
            const value = await SecureStore.getItemAsync(key, KEYCHAIN_OPTS);
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
          await keychainReady;
          memoryCache.set(key, value);
          try {
            await SecureStore.setItemAsync(key, value, KEYCHAIN_OPTS);
          } catch {
            // Keychain write failed; the in-memory copy above still lets reads
            // succeed this session without writing plaintext to disk.
          }
        },
        removeItem: async (key: string): Promise<void> => {
          await keychainReady;
          memoryCache.delete(key);
          // Sign-out MUST leave nothing readable. Swallowing a delete failure
          // here silently kept the refresh token at rest, and getItem() above
          // would hand it straight back on the next launch — the user believes
          // they signed out (typically right before handing the phone over) and
          // the session is still live. Retry once, and if the Keychain still
          // refuses, blank the value: auth-js treats an empty string as "no
          // session", so the token is unusable even if the item survives.
          let deleted = false;
          for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
            try {
              await SecureStore.deleteItemAsync(key, KEYCHAIN_OPTS);
              deleted = true;
            } catch (err) {
              if (attempt === 1) {
                console.warn('[supabase] SecureStore delete failed for', key, err);
                try { await SecureStore.setItemAsync(key, '', KEYCHAIN_OPTS); } catch {}
              }
            }
          }
          // Also drop any legacy plaintext copy left in AsyncStorage by the
          // pre-hardening mirror, so sign-out fully clears on-disk session
          // state (the new adapter never writes it, but old installs still have
          // it until the first sign-out or the one-time purge above runs).
          try { await AsyncStorage.removeItem(key); } catch {}
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
      // Authorization Code + PKCE for every browser-based flow (Google OAuth).
      // auth-js defaults to `implicit`, which returns the access AND refresh
      // token in the callback URL's `#` fragment with nothing binding the
      // response to the app that started it — so a single stale or wildcard
      // entry in the project's redirect allowlist turns a genuine Google login
      // into a token handoff to an attacker's endpoint, and any fallback off
      // ASWebAuthenticationSession exposes the tokens to whatever else has
      // registered the `clippar://` scheme. With PKCE the callback carries only
      // a `code`, useless without the verifier this client keeps in the
      // Keychain. hooks/useAuth.signInWithGoogle exchanges it.
      flowType: 'pkce',
    },
  }
);
