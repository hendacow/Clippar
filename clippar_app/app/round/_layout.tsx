import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function RoundLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_right',
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="preview" options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
    </Stack>
  );
}
