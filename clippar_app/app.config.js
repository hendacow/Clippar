/**
 * Dynamic Expo config — selects bundle id, name, and Supabase project
 * based on `APP_VARIANT` so we can run Dev / Staging / Production builds
 * side-by-side on the same device. Picked up by EAS Build via the `env`
 * block in each eas.json profile, and by `expo start` via
 * `APP_VARIANT=development npx expo start`.
 *
 * Variants:
 *   APP_VARIANT=development → com.clippar.app.dev     / "Clippar Dev"
 *   APP_VARIANT=staging     → com.clippar.app.staging / "Clippar Staging"
 *   default                 → com.clippar.app         / "Clippar"
 */

const APP_VARIANT = process.env.APP_VARIANT;
const IS_DEV = APP_VARIANT === 'development';
const IS_STAGING = APP_VARIANT === 'staging';

const NAME = IS_DEV ? 'Clippar Dev' : IS_STAGING ? 'Clippar Staging' : 'Clippar';
const BUNDLE_ID = IS_DEV
  ? 'com.clippar.app.dev'
  : IS_STAGING
    ? 'com.clippar.app.staging'
    : 'com.clippar.app';
const SCHEME = IS_DEV ? 'clippar-dev' : IS_STAGING ? 'clippar-staging' : 'clippar';
const VARIANT = IS_DEV ? 'development' : IS_STAGING ? 'staging' : 'production';

module.exports = () => ({
  expo: {
    name: NAME,
    slug: 'clippar',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: SCHEME,
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: {
      image: './assets/images/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0A0A0F',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: BUNDLE_ID,
      usesAppleSignIn: true,
      infoPlist: {
        // Bluetooth: the only BLE use is connecting to the user's shot clicker
        // (a remote) to mark shots hands-free while recording. iOS 13+ uses the
        // "Always" key; the deprecated Peripheral key is kept for older iOS.
        // NOTE: no background Bluetooth — the clicker is used in the foreground
        // while recording, and useBLE.ts does not implement CoreBluetooth state
        // restoration, so the `bluetooth-central` UIBackgroundMode was removed
        // (Apple rejects unused background modes).
        NSBluetoothAlwaysUsageDescription:
          'Clippar connects to your shot clicker over Bluetooth so you can mark each shot hands-free while recording.',
        NSBluetoothPeripheralUsageDescription:
          'Clippar connects to your shot clicker over Bluetooth so you can mark each shot hands-free while recording.',
        // Face ID: biometrics.ts gates app access with LocalAuthentication so
        // only the owner can open the app and view their rounds/clips.
        NSFaceIDUsageDescription:
          'Clippar uses Face ID to unlock the app so only you can view your rounds and clips.',
        // Standard HTTPS/TLS only — no proprietary/non-exempt encryption. Set
        // so every TestFlight/App Store build skips the export-compliance prompt.
        ITSAppUsesNonExemptEncryption: false,
      },
      // Apple privacy manifest (PrivacyInfo.xcprivacy). Expo SDK 54 aggregates
      // each library's bundled manifest at prebuild; this block adds the
      // "Required Reason API" declarations for APIs the app + its deps touch:
      //   • UserDefaults (CA92.1)      — @react-native-async-storage/async-storage
      //   • File timestamp (C617.1)    — expo-file-system / expo-sqlite
      //   • Disk space (E174.1)        — storage management / media writes
      //   • System boot time (35F9.1)  — React Native core / boost elapsed-time
      // Clippar collects no advertising identifier and does no cross-app
      // tracking, so NSPrivacyTracking stays false and there are no tracking
      // domains (see APPSTORE_READINESS.md → App Privacy / ATT).
      //
      // NSPrivacyCollectedDataTypes must mirror what the binary ACTUALLY sends
      // off-device. It was previously an empty array, which is a false privacy
      // disclosure shipped inside the app: Apple reconciles the manifest against
      // observed SDK/network behaviour and pulls builds that under-declare, and
      // an empty array is the artefact a regulator would hold up against the
      // App Store privacy answers. Every entry below is backed by a call site —
      // keep them in sync, and add a type BEFORE adding the code that sends it:
      //   • EmailAddress / UserID — Supabase Auth sign-in (app/(auth)/*,
      //     lib/supabase.ts) stores the account email and user id server-side.
      //   • PreciseLocation — per-shot GPS captured at hooks/useCamera.ts:430,
      //     persisted to local_clips.gps_latitude/longitude (lib/storage.ts:23)
      //     and sent to the `shots` table by lib/uploadQueue.ts:232 whenever
      //     cloud backup is on. Off by default, but "collected" once enabled.
      //   • PhotosorVideos — clip and reel uploads (lib/r2.ts:34 and :272),
      //     including each video's original audio track.
      //   • CrashData / PerformanceData — Sentry, initialised unconditionally at
      //     app/_layout.tsx:46 with tracesSampleRate 0.1.
      //   • PurchaseHistory — RevenueCat/StoreKit (lib/iap.ts) and Stripe
      //     (lib/stripe.ts) receive subscription and mount-kit purchase state.
      // All of it is linked to the account and none of it is used for tracking
      // or advertising, hence Linked:true / Tracking:false throughout.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeEmailAddress',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeUserID',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePreciseLocation',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePhotosorVideos',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePurchaseHistory',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAnalytics',
            ],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePerformanceData',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAnalytics',
            ],
          },
        ],
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
            NSPrivacyAccessedAPITypeReasons: ['E174.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
        ],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        backgroundColor: '#0A0A0F',
      },
      package: BUNDLE_ID,
      edgeToEdgeEnabled: true,
      permissions: [
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
      ],
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      'expo-video',
      'expo-sqlite',
      'expo-secure-store',
      // NOTE: expo-notifications is intentionally NOT a config plugin here.
      // Remote push has no runtime path yet — registerForPushNotifications()
      // in lib/notifications.ts has zero call sites and there are no listeners —
      // so granting the iOS `aps-environment` entitlement would ship an unused
      // capability (an App Review red flag). Add the plugin only once push is
      // actually wired up (registration + handlers + an APNs key). See
      // APPSTORE_READINESS.md → "Future / not in this PR".
      // Apple Sign-In — adds the entitlement and required iOS capability.
      // Required for App Store Guideline 4.8 once any third-party login
      // (Google etc.) is offered. iOS-only — no-op on Android/web.
      'expo-apple-authentication',
      [
        'expo-build-properties',
        {
          ios: {
            useFrameworks: 'static',
          },
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'Clippar needs camera access to record your golf shots',
          microphonePermission: 'Clippar needs microphone access for shot audio detection',
          recordAudioAndroid: true,
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Clippar uses your location to match each shot to the right hole and measure shot distances on the course.',
          // Clippar only reads location while you are actively recording a round
          // (foreground): useLocation.ts calls requestForegroundPermissionsAsync
          // and watchPositionAsync — never the background variants. Passing
          // `false` deletes the unused "Always" Info.plist keys so the app does
          // not request location access it never uses (an App Review red flag).
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission: 'Clippar saves your highlight reels to your photo library.',
          savePhotosPermission: 'Clippar saves your highlight reels to your photo library.',
        },
      ],
      // Sentry — error tracking. The config plugin wires up the iOS/Android
      // SDKs and source-map upload during EAS builds (needs SENTRY_AUTH_TOKEN
      // EAS secret). DSN + environment are passed at Sentry.init() time in
      // app/_layout.tsx so we can tag dev vs preview vs production correctly.
      [
        '@sentry/react-native/expo',
        {
          organization: 'clippar',
          project: 'clippar',
          // url defaults to https://sentry.io for SaaS; no need to set.
        },
      ],
      // Stripe SDK — no `merchantIdentifier` on purpose. Declaring it adds the
      // Apple Pay in-app-payments entitlement, which requires the Merchant ID
      // to exist in the Apple Developer portal and the Apple Pay capability on
      // the provisioning profile — neither of which is set up, so it fails the
      // build. v1 doesn't use in-app Apple Pay: Clippar Pro is StoreKit IAP,
      // and the physical mount kit checks out via the web Stripe payment link
      // (clippargolf.com/mount), not in-app. Re-add `merchantIdentifier` here
      // AND register the Merchant ID + Apple Pay capability in the portal if
      // in-app Apple Pay is ever added.
      [
        '@stripe/stripe-react-native',
        {
          enableGooglePay: false,
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      eas: {
        projectId: '2c16b1a5-b169-4d92-b4fc-913067dd4fc6',
      },
      router: {},
      variant: VARIANT,
    },
    owner: 'clippar',
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/2c16b1a5-b169-4d92-b4fc-913067dd4fc6',
      // Wait up to 5 seconds at cold start for a downloaded OTA bundle to
      // be ready before falling back to the embedded one. Without this
      // (default 0), the app launches with embedded immediately and any
      // already-downloaded OTA never gets loaded — confirmed by iOS
      // Console.app showing zero EXUpdates logs at cold start.
      // Cost: ~0ms when no update is pending (fast path); up to 5s when
      // a freshly-downloaded bundle is being applied.
      fallbackToCacheTimeout: 5000,
    },
  },
});
