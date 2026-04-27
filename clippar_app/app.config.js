/**
 * Dynamic Expo config — selects bundle id, name, and Supabase project
 * based on `APP_VARIANT` so we can run a Dev build alongside Production
 * on the same device. Picked up by EAS Build via the `env` block in each
 * eas.json profile, and by `expo start` via `APP_VARIANT=development npx expo start`.
 *
 * Variants:
 *   APP_VARIANT=development → com.clippar.app.dev / "Clippar Dev"
 *   default                 → com.clippar.app     / "Clippar"
 */

const IS_DEV = process.env.APP_VARIANT === 'development';

module.exports = () => ({
  expo: {
    name: IS_DEV ? 'Clippar Dev' : 'Clippar',
    slug: 'clippar',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: IS_DEV ? 'clippar-dev' : 'clippar',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: {
      image: './assets/images/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0A0A0F',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: IS_DEV ? 'com.clippar.app.dev' : 'com.clippar.app',
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
      package: IS_DEV ? 'com.clippar.app.dev' : 'com.clippar.app',
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
          locationAlwaysAndWhenInUsePermission:
            'Clippar uses your location to match shots to holes on the course',
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission: 'Clippar saves your highlight reels to your photo library.',
          savePhotosPermission: 'Clippar saves your highlight reels to your photo library.',
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
      variant: IS_DEV ? 'development' : 'production',
    },
    owner: 'clippar',
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/2c16b1a5-b169-4d92-b4fc-913067dd4fc6',
    },
  },
});
