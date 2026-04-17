import { View, ViewStyle, DimensionValue } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { theme } from '@/constants/theme';

interface SkeletonProps {
  width: DimensionValue;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

/**
 * Shimmering skeleton — a moving highlight sweeps across the surface.
 * More polished than a simple opacity pulse.
 */
export function Skeleton({
  width,
  height,
  borderRadius = theme.radius.sm,
  style,
}: SkeletonProps) {
  const shimmer = useSharedValue(0);

  useEffect(() => {
    shimmer.value = withRepeat(withTiming(1, { duration: 1400 }), -1, false);
  }, [shimmer]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          shimmer.value,
          [0, 1],
          [-200, 400],
          Extrapolation.CLAMP
        ),
      },
    ],
  }));

  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: theme.colors.surface,
          overflow: 'hidden',
        },
        style,
      ]}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
    >
      <AnimatedLinearGradient
        colors={[
          'transparent',
          theme.colors.surfaceBorder,
          'transparent',
        ]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={[
          { width: '60%', height: '100%' },
          animatedStyle,
        ]}
      />
    </View>
  );
}

export function SkeletonCard() {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.lg,
        padding: theme.spacing.md,
        gap: 12,
      }}
    >
      <Skeleton width="60%" height={16} />
      <Skeleton width="40%" height={12} />
      <Skeleton width="100%" height={120} borderRadius={theme.radius.md} />
    </View>
  );
}
