console.log("OTA test 2026-05-17");
import { useEffect, useState } from 'react';
import { Platform, LogBox } from 'react-native';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import * as SplashScreen from 'expo-splash-screen';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { theme } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useSalesFlowDone } from '@/lib/salesFlow';
import { resolvePostAuthRoute } from '@/lib/mountOffer';
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
import { reclaimTemporaryExports } from '@/modules/shot-detector';
import { excludePrivateMediaFromBackup } from '@/lib/media';
import { getDatabase } from '@/lib/storage';
import '@/global.css';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Sentry — error tracking. Init must happen synchronously at module load,
// BEFORE the first React render, so uncaught errors during boot are captured.
// `environment` tag is read from APP_VARIANT (set in app.config.js) so we
// can filter dev noise out of the prod dashboard. DSN is the public Sentry
// ingest URL — safe to hardcode (it identifies the project, not a secret).
// Supabase auth-js logs `AuthApiError: Invalid Refresh Token` to console.error
// from inside its own _recoverAndRefresh() when a stored refresh token has
// expired/rotated — it clears the session itself and the app lands on login
// cleanly (see hooks/useAuth.ts). It's an EXPECTED auth-state transition, not a
// bug, but RN surfaces console.error as a red LogBox overlay in dev builds and
// Sentry would capture it as noise. The app-level getSession() try/catch can't
// intercept it (auth-js doesn't re-throw), so we filter it at the two places it
// actually shows up: the dev LogBox (below) and Sentry (beforeSend).
LogBox.ignoreLogs([/Invalid Refresh Token/, /Refresh Token Not Found/]);

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
  // Drop the expected stale-refresh-token AuthApiError (see note above) so it
  // doesn't pollute the error dashboard. Any other error passes through.
  beforeSend(event) {
    const msg =
      event.exception?.values?.[0]?.value ?? event.message ?? '';
    if (/Invalid Refresh Token|Refresh Token Not Found/.test(msg)) return null;
    return event;
  },
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
  // Cold-start sales funnel gate (feat/onboarding-flow). Disconnect by
  // deleting lib/salesFlow + the (onboarding) route — this becomes a no-op.
  const sales = useSalesFlowDone();

  // Auth gate. Standard expo-router pattern: watch the current route
  // segments + auth state, push the user into the right group.
  //   - First-time signed-out visitor → cold-start sales funnel /(onboarding)
  //   - Signed-out user inside (tabs)/round/profile → bounce to /(auth)/login
  //   - Signed-in user on any (auth)/(onboarding) screen → bounce to /(tabs)
  // Wait for auth + the sales flag to finish loading so we don't redirect on
  // a stale null user during cold start.
  useEffect(() => {
    if (loading || !sales.loaded) return;
    const inAuthGroup = segments[0] === '(auth)';
    const inOnboardingGroup = segments[0] === '(onboarding)';
    // The onboarding funnel hands off to /paywall BEFORE signup (StoreKit
    // trials are Apple-ID scoped — no account needed). Don't bounce a
    // signed-out user off it; the paywall itself routes forward to signup
    // when opened from onboarding (?from=onboarding).
    // BOTH layers: /paywall is the paid offer, /paywall-trial the
    // second-chance trial it hands off to. Miss the second one here and a
    // signed-out golfer tapping "Continue to free" is bounced straight to
    // login — the layer would be unreachable in the only funnel it exists for.
    const onPaywall = segments[0] === 'paywall' || segments[0] === 'paywall-trial';
    // Dev builds only: (dev) harness screens (tracer-sim, detection-ab) are
    // reachable without sign-in so simulator automation can deep-link to them.
    const inDevGroup = __DEV__ && segments[0] === '(dev)';
    if (!user) {
      // Brand-new visitor (cold from the Instagram ad) → sell first.
      if (!sales.done && !inAuthGroup && !inOnboardingGroup && !inDevGroup && !onPaywall) {
        router.replace('/(onboarding)');
      } else if (sales.done && !inAuthGroup && !inOnboardingGroup && !inDevGroup && !onPaywall) {
        router.replace('/(auth)/login');
      }
    } else if (user && (inAuthGroup || inOnboardingGroup)) {
      // The password-reset flow establishes a session mid-form (verifyOtp);
      // navigating away here would unmount the form before the new password
      // is saved. Let the screen finish and navigate itself.
      if ((segments as string[])[1] === 'reset-password') return;
      // New-account handoff (feat/mount-upsell): a freshly created account
      // gets the one-time Clippar Mount offer before landing on the tabs;
      // returning logins go straight home. Async because the seen/pending
      // flags live in SQLite; fail-open to the tabs. The cancellation guard
      // kills stale promises — auth emits several user-object identities in
      // quick succession, and a stale resolve racing the screen-level
      // navigation could otherwise yank the user off the just-mounted offer
      // (which marks itself seen immediately, losing it forever).
      let cancelled = false;
      resolvePostAuthRoute(user).then((route) => {
        if (!cancelled) router.replace(route as never);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [user, loading, sales.loaded, sales.done, segments, router]);

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

      // MEDIA-003: reclaim aged-out trim_/stitch_/tracer_/clippar_reel_
      // temporaries from Library/Caches. Each is a full-fidelity copy of the
      // golfer's footage and nothing ever removed them, so they outlived the
      // round the user deleted and accumulated for the life of the install.
      //
      // The in-use set is read from SQLite FIRST and the sweep only runs if
      // that read SUCCEEDS — an await that throws here skips
      // reclaimTemporaryExports entirely, because a failed query read as "no
      // clips are in use" would delete every trimmed clip and tracer render
      // the library still points at. Composed reels are reel_<UUID>.mp4 and
      // are not in the swept prefixes at all, so they can never be caught by
      // this even though nothing local records their path.
      // Mark every private-media location NSURLIsExcludedFromBackupKey. Runs at
      // startup rather than lazily because the SQLite database and exports/
      // exist without anyone persisting a clip this session — the DB is opened
      // on first read and exports/ survives from previous runs — so hanging this
      // off the clips/ creation path (as it originally was) left the two
      // directories carrying GPS coordinates and full-fidelity shared clips
      // still going to iCloud.
      excludePrivateMediaFromBackup().catch((e) =>
        console.log('[Startup] excludePrivateMediaFromBackup skipped:', e)
      );

      (async () => {
        const database = await getDatabase();
        const rows = await database.getAllAsync<{
          file_uri: string | null;
          trimmed_file_uri: string | null;
          original_file_uri: string | null;
          tracer_file_uri: string | null;
        }>(
          'SELECT file_uri, trimmed_file_uri, original_file_uri, tracer_file_uri FROM local_clips'
        );
        return reclaimTemporaryExports({
          inUseUris: rows.flatMap((r) => [
            r.file_uri,
            r.trimmed_file_uri,
            r.original_file_uri,
            r.tracer_file_uri,
          ]),
        });
      })()
        .then(({ deletedCount, skippedInUse, skippedTooRecent }) => {
          if (deletedCount > 0) {
            console.log(
              `[Startup] reclaimTemporaryExports: freed ${deletedCount} ` +
                `(kept ${skippedInUse} in use, ${skippedTooRecent} recent)`
            );
          }
        })
        .catch((e) => console.log('[Startup] reclaimTemporaryExports skipped:', e));

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
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen
              name="round"
              options={{ animation: 'slide_from_bottom' }}
            />
            <Stack.Screen name="profile" />
            <Stack.Screen
              name="paywall"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            {/* Layer 2. Same modal presentation as layer 1 because it
                REPLACES it — a card animation would slide a "new" screen in
                over a modal that is already up. Fade reads as the same sheet
                changing its mind. */}
            <Stack.Screen
              name="paywall-trial"
              options={{ presentation: 'modal', animation: 'fade' }}
            />
            <Stack.Screen name="mount-offer" options={{ animation: 'fade' }} />
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
