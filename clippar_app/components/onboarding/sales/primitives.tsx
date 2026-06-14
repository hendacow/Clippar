/**
 * Reusable animated primitives for the cold-start sales funnel.
 * Reanimated 4 + react-native-svg + expo-haptics. No new native modules.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  useAnimatedReaction,
  withTiming,
  withSpring,
  withDelay,
  withSequence,
  interpolate,
  interpolateColor,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { Star } from 'lucide-react-native';
import { theme } from '@/constants/theme';

const GOLD = '#F2C14E';
const AnimatedText = Animated.createAnimatedComponent(TextInput);

/* ── Primary CTA: press-spring + haptic ───────────────────────────────── */
export function FlowButton({
  label,
  onPress,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost';
  style?: ViewStyle;
}) {
  const scale = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const isPrimary = variant === 'primary';
  return (
    <Animated.View style={[aStyle, style]}>
      <Pressable
        onPressIn={() => {
          scale.value = withTiming(0.96, { duration: 90 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 12 });
        }}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onPress();
        }}
        style={{
          backgroundColor: isPrimary ? theme.colors.primary : 'transparent',
          borderRadius: theme.radius.lg,
          paddingVertical: 16,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            color: isPrimary ? '#fff' : theme.colors.textSecondary,
            fontWeight: isPrimary ? '800' : '600',
            fontSize: isPrimary ? 16 : 14,
          }}
        >
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/* ── Progress dots ────────────────────────────────────────────────────── */
export function ProgressDots({ count, index }: { count: number; index: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            width: i === index ? 22 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i === index ? theme.colors.primary : theme.colors.surfaceBorder,
          }}
        />
      ))}
    </View>
  );
}

/* ── Commitment chip: spring-in, select glow ──────────────────────────── */
export function TapChip({
  label,
  selected,
  dimmed,
  onPress,
  delay = 0,
  icon,
}: {
  label: string;
  selected: boolean;
  dimmed: boolean;
  onPress: () => void;
  delay?: number;
  icon?: React.ReactNode;
}) {
  const enter = useSharedValue(0);
  const press = useSharedValue(0);
  useEffect(() => {
    enter.value = withDelay(delay, withSpring(1, { damping: 14 }));
  }, [delay, enter]);
  useEffect(() => {
    if (selected) press.value = withSequence(withTiming(1, { duration: 120 }), withTiming(0.6, { duration: 160 }));
  }, [selected, press]);

  const aStyle = useAnimatedStyle(() => ({
    opacity: dimmed ? withTiming(0.45) : withTiming(interpolate(enter.value, [0, 1], [0, 1])),
    transform: [
      { translateY: interpolate(enter.value, [0, 1], [16, 0]) },
      { scale: 1 + press.value * 0.06 },
    ],
    borderColor: interpolateColor(selected ? 1 : 0, [0, 1], [theme.colors.surfaceBorder, theme.colors.primary]),
  }));

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
    >
      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            backgroundColor: selected ? `${theme.colors.primary}1A` : theme.colors.surfaceElevated,
            borderWidth: 2,
            borderRadius: theme.radius.lg,
            paddingVertical: 18,
            paddingHorizontal: 18,
          },
          aStyle,
        ]}
      >
        {icon}
        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700', flex: 1 }}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/* ── Star rating: left-to-right "earned" fill ─────────────────────────── */
export function StarRating({
  value = 5,
  size = 22,
  animate = true,
  onComplete,
}: {
  value?: number;
  size?: number;
  animate?: boolean;
  onComplete?: () => void;
}) {
  const stars = Array.from({ length: 5 });
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {stars.map((_, i) => (
        <AnimatedStar
          key={i}
          filled={i < Math.round(value)}
          size={size}
          delay={animate ? i * 90 : 0}
          last={i === 4}
          onComplete={onComplete}
        />
      ))}
    </View>
  );
}

function AnimatedStar({
  filled,
  size,
  delay,
  last,
  onComplete,
}: {
  filled: boolean;
  size: number;
  delay: number;
  last: boolean;
  onComplete?: () => void;
}) {
  const pop = useSharedValue(0);
  useEffect(() => {
    pop.value = withDelay(
      delay,
      withSequence(
        withTiming(1.2, { duration: 140 }),
        withTiming(1, { duration: 140 }, (done) => {
          if (done && last && onComplete) runOnJS(onComplete)();
        })
      )
    );
  }, [delay, last, onComplete, pop]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.value }],
    opacity: pop.value === 0 ? 0 : 1,
  }));
  return (
    <Animated.View style={aStyle}>
      <Star size={size} color={GOLD} fill={filled ? GOLD : 'transparent'} strokeWidth={2} />
    </Animated.View>
  );
}

/* ── Count-up number (animatedProps into a TextInput) ─────────────────── */
export function CountUp({
  to,
  durationMs = 1200,
  prefix = '',
  suffix = '',
  milestones = [],
  style,
}: {
  to: number;
  durationMs?: number;
  prefix?: string;
  suffix?: string;
  milestones?: number[];
  style?: object;
}) {
  const v = useSharedValue(0);
  const lastTick = useSharedValue(0);
  useEffect(() => {
    v.value = withTiming(to, { duration: durationMs, easing: Easing.out(Easing.cubic) });
  }, [to, durationMs, v]);

  const tick = () => Haptics.selectionAsync();
  // useAnimatedProps must stay PURE (returning only props). JS side-effects
  // from an animated value go through useAnimatedReaction — doing runOnJS +
  // shared-value writes inside useAnimatedProps trips Reanimated's worklet
  // reentrancy guard and hard-crashes the app.
  useAnimatedReaction(
    () => v.value,
    (cur) => {
      for (const m of milestones) {
        if (cur >= m && lastTick.value < m) {
          lastTick.value = m;
          runOnJS(tick)();
        }
      }
    }
  );

  const animatedProps = useAnimatedProps(() => ({
    text: `${prefix}${Math.round(v.value).toLocaleString()}${suffix}`,
    defaultValue: `${prefix}0${suffix}`,
  })) as object;

  return (
    <AnimatedText
      editable={false}
      underlineColorAndroid="transparent"
      style={[styles.countText, style]}
      animatedProps={animatedProps}
    />
  );
}

/* ── Trial timeline: Today → reminder → billed ────────────────────────── */
export function TrialTimeline({ days, reminderBefore }: { days: number; reminderBefore: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(200, withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [progress]);

  // Plain animated-width bar over a static track — no animated SVG geometry
  // (animating <Line x2> via reanimated is fragile and can crash).
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  const nodes = [
    { label: 'Today', sub: 'Full access' },
    { label: `Day ${days - reminderBefore}`, sub: 'We remind you' },
    { label: `Day ${days}`, sub: 'Billed · cancel anytime' },
  ];

  return (
    <View style={{ marginVertical: 8 }}>
      <View style={{ height: 14, justifyContent: 'center', marginBottom: 8 }}>
        {/* track */}
        <View style={{ height: 3, backgroundColor: theme.colors.surfaceBorder, borderRadius: 2 }} />
        {/* animated fill */}
        <Animated.View
          style={[
            { position: 'absolute', left: 0, height: 3, backgroundColor: theme.colors.primary, borderRadius: 2 },
            fillStyle,
          ]}
        />
        {/* nodes */}
        <View style={{ position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
          {nodes.map((_, i) => (
            <View
              key={i}
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: i === nodes.length - 1 ? GOLD : theme.colors.primary,
              }}
            />
          ))}
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {nodes.map((n, i) => (
          <View key={i} style={{ alignItems: i === 0 ? 'flex-start' : i === 2 ? 'flex-end' : 'center', flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700' }}>{n.label}</Text>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 10 }}>{n.sub}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  countText: {
    color: '#fff',
    fontSize: 40,
    fontWeight: '900',
    padding: 0,
    textAlign: 'center',
  },
});
