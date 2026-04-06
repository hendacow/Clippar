import { View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '@/constants/theme';

interface GradientBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export function GradientBackground({ children, style }: GradientBackgroundProps) {
  return (
    <View style={[{ flex: 1, backgroundColor: theme.colors.background }, style]}>
      <LinearGradient
        colors={['rgba(76, 175, 80, 0.05)', 'transparent', 'transparent']}
        locations={[0, 0.3, 1]}
        style={{ flex: 1 }}
      >
        {children}
      </LinearGradient>
    </View>
  );
}
