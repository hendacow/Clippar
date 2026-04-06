import { View, Text } from 'react-native';
import { theme } from '@/constants/theme';

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
  color?: string;
}

export function ProgressBar({ progress, label, color = theme.colors.primary }: ProgressBarProps) {
  const clampedProgress = Math.max(0, Math.min(100, progress));

  return (
    <View style={{ gap: 6 }}>
      {label && (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{label}</Text>
      )}
      <View
        style={{
          height: 6,
          backgroundColor: theme.colors.surfaceBorder,
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: '100%',
            width: `${clampedProgress}%`,
            backgroundColor: color,
            borderRadius: 3,
          }}
        />
      </View>
    </View>
  );
}
