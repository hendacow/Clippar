import { View, Text, Linking } from 'react-native';
import { Camera } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Button } from '@/components/ui/Button';

interface CameraPermissionScreenProps {
  onRetry: () => void;
}

export function CameraPermissionScreen({ onRetry }: CameraPermissionScreenProps) {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
        backgroundColor: theme.colors.background,
      }}
    >
      <View
        style={{
          width: 80,
          height: 80,
          borderRadius: 40,
          backgroundColor: theme.colors.primaryMuted,
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <Camera size={36} color={theme.colors.primary} />
      </View>

      <Text
        style={{
          ...theme.typography.h2,
          color: theme.colors.textPrimary,
          textAlign: 'center',
          marginBottom: 12,
        }}
      >
        Camera Access Required
      </Text>

      <Text
        style={{
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          textAlign: 'center',
          maxWidth: 300,
          marginBottom: 32,
        }}
      >
        Clippar needs camera access to record your golf shots. Please enable camera access in Settings.
      </Text>

      <Button
        title="Open Settings"
        onPress={() => Linking.openSettings()}
        style={{ width: '100%', marginBottom: 12 }}
      />

      <Button
        title="Try Again"
        onPress={onRetry}
        variant="secondary"
        style={{ width: '100%' }}
      />
    </View>
  );
}
