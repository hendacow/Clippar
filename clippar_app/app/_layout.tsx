import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import * as SplashScreen from 'expo-splash-screen';
import { theme } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { StripeWrapper } from '@/components/shared/StripeWrapper';
import { UploadProvider } from '@/contexts/UploadContext';
import {
  getBiometricPreference,
  authenticateWithBiometrics,
} from '@/lib/biometrics';
import { repairScoresParData } from '@/lib/api';
import { migrateLegacyUris } from '@/lib/uriMigration';
import { initializeUploadQueueProcessor } from '@/lib/uploadQueue';
import '@/global.css';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  // Start at home — auth is gated per-action, not per-app
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { loading } = useAuth();
  const [biometricChecked, setBiometricChecked] = useState(false);

  useEffect(() => {
    if (loading) return;

    (async () => {
      if (isNative) {
        const biometricEnabled = await getBiometricPreference();
        if (biometricEnabled) {
          const success = await authenticateWithBiometrics();
          if (!success) {
            return;
          }
        }
      }
      setBiometricChecked(true);
      SplashScreen.hideAsync();

      // One-time idempotent repair: backfill scores.par/score_to_par for rows
      // written before migration 005. Safe to call every startup (no-op when
      // there's nothing to fix).
      repairScoresParData()
        .then((n) => {
          if (n > 0) console.log(`[Startup] repairScoresParData: fixed ${n} rows`);
        })
        .catch((e) => console.log('[Startup] repairScoresParData skipped:', e));

      // Retroactively promote ph:// / assets-library:// / /tmp/ URIs to durable
      // file:// paths so already-imported rounds survive iOS tmp eviction.
      migrateLegacyUris()
        .then(({ scanned, migrated }) => {
          if (scanned > 0) {
            console.log(`[Startup] migrateLegacyUris: ${migrated}/${scanned} clips updated`);
          }
        })
        .catch((e) => console.log('[Startup] migrateLegacyUris skipped:', e));

      // Drain the persistent upload queue + subscribe to NetInfo so queued
      // rounds upload automatically whenever connectivity returns.
      try {
        initializeUploadQueueProcessor();
      } catch (e) {
        console.log('[Startup] initializeUploadQueueProcessor skipped:', e);
      }
    })();
  }, [loading]);

  if (loading || !biometricChecked) return null;

  return (
    <StripeWrapper>
      <UploadProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <BottomSheetModalProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.colors.background },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen
              name="round"
              options={{ animation: 'slide_from_bottom' }}
            />
            <Stack.Screen name="profile" />
          </Stack>
        </BottomSheetModalProvider>
      </GestureHandlerRootView>
      </UploadProvider>
    </StripeWrapper>
  );
}
