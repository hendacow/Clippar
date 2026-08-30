import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function TrainingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_right',
        gestureEnabled: true,
      }}
    >
      {/* The capture screen swipes down like a camera sheet, and back-swipe
          is disabled so a stray edge drag can't unmount the CameraView under
          an active recordAsync — the same reason record.tsx gates every
          round-mutating action on recordingBusy. */}
      <Stack.Screen name="record" options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
    </Stack>
  );
}
