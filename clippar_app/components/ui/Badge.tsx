import { View, Text, type ViewStyle } from 'react-native';
import { theme } from '@/constants/theme';

type BadgeVariant = 'connected' | 'disconnected' | 'recording' | 'processing' | 'ready';

const badgeConfig: Record<BadgeVariant, { bg: string; dot: string; label: string }> = {
  connected: { bg: theme.colors.primaryMuted, dot: theme.colors.connected, label: 'Connected' },
  disconnected: { bg: 'rgba(255, 68, 68, 0.15)', dot: theme.colors.disconnected, label: 'Disconnected' },
  recording: { bg: 'rgba(255, 59, 48, 0.15)', dot: theme.colors.recording, label: 'Recording' },
  processing: { bg: 'rgba(255, 152, 0, 0.15)', dot: theme.colors.processing, label: 'Processing' },
  ready: { bg: theme.colors.primaryMuted, dot: theme.colors.ready, label: 'Ready' },
};

export interface BadgeProps {
  variant: BadgeVariant;
  label?: string;
  style?: ViewStyle;
}

export function Badge({ variant, label, style }: BadgeProps) {
  const config = badgeConfig[variant];

  return (
    <View
      style={[{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: config.bg,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: theme.radius.full,
        gap: 6,
      }, style]}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: config.dot,
        }}
      />
      <Text style={{ color: config.dot, fontSize: 12, fontWeight: '600' }}>
        {label ?? config.label}
      </Text>
    </View>
  );
}
