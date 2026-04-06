import { Pressable, Text, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  icon?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, { container: ViewStyle; text: TextStyle }> = {
  primary: {
    container: {
      backgroundColor: theme.colors.primary,
    },
    text: { color: '#FFFFFF', fontWeight: '700' },
  },
  secondary: {
    container: {
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: theme.colors.primary,
    },
    text: { color: theme.colors.primary, fontWeight: '600' },
  },
  danger: {
    container: {
      backgroundColor: theme.colors.accentRed,
    },
    text: { color: '#FFFFFF', fontWeight: '700' },
  },
  ghost: {
    container: {
      backgroundColor: 'transparent',
    },
    text: { color: theme.colors.textSecondary, fontWeight: '500' },
  },
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
  textStyle,
  icon,
}: ButtonProps) {
  const styles = variantStyles[variant];
  const isDisabled = disabled || loading;

  const handlePress = () => {
    if (isDisabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 14,
          paddingHorizontal: 24,
          borderRadius: theme.radius.full,
          gap: 8,
          opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1,
        },
        styles.container,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={styles.text.color} size="small" />
      ) : (
        <>
          {icon}
          <Text style={[{ fontSize: 16 }, styles.text, textStyle]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}
