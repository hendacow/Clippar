import { View, ViewStyle } from 'react-native';
import { theme } from '@/constants/theme';

interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export function Card({ children, style }: CardProps) {
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          padding: theme.spacing.md,
          ...theme.shadows.card,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
