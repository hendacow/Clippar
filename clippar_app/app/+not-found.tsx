import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';

export default function NotFoundScreen() {
  return (
    <GradientBackground>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ ...theme.typography.h2, color: theme.colors.textPrimary, marginBottom: 8 }}>
          Page Not Found
        </Text>
        <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 24 }}>
          This screen doesn't exist.
        </Text>
        <Button title="Go Home" onPress={() => router.replace('/(tabs)')} variant="secondary" />
      </View>
    </GradientBackground>
  );
}
