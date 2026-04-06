import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function RoundLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_bottom',
      }}
    />
  );
}
