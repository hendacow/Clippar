console.log("OTA test 2026-05-17");
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import * as SplashScreen from 'expo-splash-screen';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { theme } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { StripeWrapper } from '@/components/shared/StripeWrapper';
import { UploadProvider } from '@/contexts/UploadContext';
import { OnboardingProvider } from '@/contexts/OnboardingContext';
import { OnboardingHost } from '@/components/onboarding/OnboardingHost';
import {
  getBiometricPreference,
  authenticateWithBiometrics,
} from '@/lib/biometrics';
import { repairScoresParData } from '@/lib/api';
import { migrateLegacyUris } from '@/lib/uriMigration';
import { hydrateMissingClipsFromPhotos } from '@/lib/photosRecovery';
import { initializeUploadQueueProcessor } from '@/lib/uploadQueue';
import '@/global.css';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Sentry — error tracking. Init must happen synchronously at module load,
// BEFORE the first React render, so uncaught errors during boot are captured.
// `environment` tag is read from APP_VARIANT (set in app.config.js) so we
// can filter dev noise out of the prod dashboard. DSN is the public Sentry
// ingest URL — safe to hardcode (it identifies the project, not a secret).
Sentry.init({
  dsn: 'https://e55b7e7e2dcc843babf891db909ceb59@o4511382424518656.ingest.us.sentry.io/4511382491365376',
  // 'development' | 'production' (from APP_VARIANT in app.config.js)
  environment: (Constants.expoConfig?.extra?.variant as string) ?? 'development',
  // Capture 10% of perf traces — keeps event budget low while still giving
  // useful timing signal. Bump if we need more visibility later.
  tracesSampleRate: 0.1,
  // In Expo dev builds RN's console.error already surfaces the LogBox red
  // screen. Sentry's debug=true would double-log every event to console —
  // helpful when first wiring up; can flip to false once verified.
  debug: __DEV__,
  // Auto-attach stack traces for console.error too, not just thrown errors.
  attachStacktrace: true,
});

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  // Start at home — auth is gated per-action, not per-app
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [biometricChecked, setBiometricChecked] = useState(false);

  // Auth gate. Standard expo-router pattern: watch the current route
  // segments + auth state, push the user into the right group.
  //   - Signed-out user inside (tabs)/round/profile → bounce to /(auth)/login
  //   - Signed-in user on any (auth) screen     → bounce to /(tabs)
  // Wait for auth to finish loading so we don't redirect on a stale null
  // user during cold start.
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!user && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (user && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, segments, router]);

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

      // After a reinstall, documentDirectory is empty but clips with a
      // photos_asset_id can be re-imported from the user's Photos library.
      hydrateMissingClipsFromPhotos()
        .then(({ scanned, recovered }) => {
          if (recovered > 0) {
            console.log(
              `[Startup] hydrateMissingClipsFromPhotos: ${recovered}/${scanned} clips re-imported`
            );
          }
        })
        .catch((e) => console.log('[Startup] hydrateMissingClipsFromPhotos skipped:', e));

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
      <OnboardingProvider>
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
          <OnboardingHost />
        </BottomSheetModalProvider>
      </GestureHandlerRootView>
      </OnboardingProvider>
      </UploadProvider>
    </StripeWrapper>
  );
}

// Wrap with Sentry so React render errors and unhandled promise rejections
// inside the tree are captured and shipped to the dashboard with breadcrumbs.
export default Sentry.wrap(RootLayout);
