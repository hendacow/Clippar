import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { config } from '@/constants/config';

// Platform-aware storage: SecureStore on native, localStorage on web
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
      return {
        getItem: (key: string) => SecureStore.getItemAsync(key),
        setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
        removeItem: (key: string) => SecureStore.deleteItemAsync(key),
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
