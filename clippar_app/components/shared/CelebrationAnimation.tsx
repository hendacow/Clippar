import { useEffect } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  runOnJS,
} from 'react-native-reanimated';
import { theme } from '@/constants/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface CelebrationAnimationProps {
  type: 'birdie' | 'eagle';
  visible: boolean;
  onComplete?: () => void;
}

const PARTICLE_COUNT = 20;
const COLORS_BIRDIE = [
  theme.colors.birdie,
  theme.colors.primary,
  '#66BB6A',
  '#81C784',
  '#A5D6A7',
];
const COLORS_EAGLE = [
  theme.colors.accentGold,
  '#FFD54F',
  '#FFC107',
  '#FFB300',
  '#FF8F00',
];

function Particle({
  color,
  delay,
  startX,
}: {
  color: string;
  delay: number;
  startX: number;
}) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(0);
  const translateX = useSharedValue(0);
  const rotate = useSharedValue(0);
  const scale = useSharedValue(0.5);

  useEffect(() => {
    opacity.value = withDelay(delay, withSequence(
      withTiming(1, { duration: 200 }),
      withDelay(800, withTiming(0, { duration: 600 }))
    ));
    translateY.value = withDelay(delay,
      withTiming(-SCREEN_HEIGHT * 0.4 - Math.random() * 200, { duration: 1600 })
    );
    translateX.value = withDelay(delay,
      withTiming((Math.random() - 0.5) * SCREEN_WIDTH * 0.6, { duration: 1600 })
    );
    rotate.value = withDelay(delay,
      withTiming(Math.random() * 720 - 360, { duration: 1600 })
    );
    scale.value = withDelay(delay,
      withSequence(
        withTiming(1.2, { duration: 400 }),
        withTiming(0.3, { duration: 1200 })
      )
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
      { scale: scale.value },
    ],
  }));

  const size = 6 + Math.random() * 8;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          bottom: 0,
          left: startX,
          width: size,
          height: size,
          borderRadius: Math.random() > 0.5 ? size / 2 : 2,
          backgroundColor: color,
        },
        animatedStyle,
      ]}
    />
  );
}

export function CelebrationAnimation({
  type,
  visible,
  onComplete,
}: CelebrationAnimationProps) {
  const colors = type === 'eagle' ? COLORS_EAGLE : COLORS_BIRDIE;

  useEffect(() => {
    if (visible && onComplete) {
      const timer = setTimeout(onComplete, 2000);
      return () => clearTimeout(timer);
    }
  }, [visible, onComplete]);

  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: PARTICLE_COUNT }).map((_, i) => (
        <Particle
          key={i}
          color={colors[i % colors.length]}
          delay={i * 60}
          startX={SCREEN_WIDTH * 0.2 + Math.random() * SCREEN_WIDTH * 0.6}
        />
      ))}
    </View>
  );
}
