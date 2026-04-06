import { Pressable } from 'react-native';
import { Stack, router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { theme } from '@/constants/theme';

export default function ProfileLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.textPrimary,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: theme.colors.background },
        headerLeft: () => (
          <Pressable onPress={() => router.back()} hitSlop={12} style={{ marginRight: 8 }}>
            <ChevronLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
        ),
      }}
    />
  );
}
