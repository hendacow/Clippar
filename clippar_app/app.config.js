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
      infoPlist: {
        NSBluetoothAlwaysUsageDescription: 'Clippar uses Bluetooth to connect to your shot clicker',
        NSBluetoothPeripheralUsageDescription: 'Clippar uses Bluetooth to connect to your shot clicker',
        UIBackgroundModes: ['bluetooth-central'],
        ITSAppUsesNonExemptEncryption: false,
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
          // v1 uses foreground location only (nearby-course search in
          // components/record/CourseSearch.tsx via hooks/useLocation.ts, which
          // calls requestForegroundPermissionsAsync). No background/Always use,
          // so declare When-In-Use only — declaring "Always" without using it
          // is an App Review rejection risk.
          locationWhenInUsePermission:
            'Clippar uses your location to find nearby golf courses',
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
