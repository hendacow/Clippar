import * as Notifications from 'expo-notifications';
import * as Device from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return null;

    // Expo push token fetch requires a valid EAS projectId.  If the app is
    // running in a dev build without EAS configured, getExpoPushTokenAsync
    // throws — catch and return null so the caller (e.g. first-launch
    // onboarding) doesn't crash.
    const projectId = Device.default.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
      console.log('[notifications] No EAS projectId — skipping push registration');
      return null;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData?.data ?? null;
    if (!token) return null;

    // Save token to profile — don't fail the whole call if this write errors.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({ expo_push_token: token })
          .eq('id', user.id);
      }
    } catch (err) {
      console.log('[notifications] Failed to save push token to profile:', err);
    }

    return token;
  } catch (err) {
    console.log('[notifications] registerForPushNotifications failed:', err);
    return null;
  }
}
