/**
 * Framework primitives for the 10-screen animated onboarding.
 *
 * - FlowProgressBar: endowed-progress bar (starts at 15%, animates per step).
 * - Rise: staggered fade+slide entrance that collapses to a plain fade-in
 *   when the OS "Reduce Motion" accessibility setting is on.
 * - FlowScreen: shared screen container (headline / sub / body / footer).
 * - SkipLink: the visible skip affordance for skippable questions.
 *
 * Tap-cards and the primary CTA reuse the existing sales primitives
 * (TapChip / FlowButton) so both funnels stay visually consistent.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withTiming,
  Easing,
  useReducedMotion,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import { theme } from '@/constants/theme';

/* ── Progress bar ─────────────────────────────────────────────────────── */

export function FlowProgressBar({ progress }: { progress: number }) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(progress);
  useEffect(() => {
    p.value = reduceMotion
      ? progress
      : withTiming(progress, { duration: 550, easing: Easing.out(Easing.cubic) });
  }, [progress, reduceMotion, p]);

  const fill = useAnimatedStyle(() => ({
    width: `${Math.min(1, Math.max(0, p.value)) * 100}%`,
  }));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
      style={styles.track}
    >
      <Animated.View style={[styles.fill, fill]} />
    </View>
  );
}

/* ── Entrance wrapper (reduced-motion aware) ──────────────────────────── */

export function Rise({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: object;
}) {
  const reduceMotion = useReducedMotion();
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(
      reduceMotion ? 0 : delay,
      withTiming(1, {
        duration: reduceMotion ? 200 : 450,
        easing: Easing.out(Easing.cubic),
      })
    );
  }, [delay, reduceMotion, v]);
  const a = useAnimatedStyle(() => ({
    opacity: v.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - v.value) * 16 }],
  }));
  return <Animated.View style={[a, style]}>{children}</Animated.View>;
}

/* ── Typography ───────────────────────────────────────────────────────── */

export function H1({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <Text style={[styles.h1, center && { textAlign: 'center' }]}>{children}</Text>;
}

export function Sub({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return <Text style={[styles.sub, center && { textAlign: 'center' }]}>{children}</Text>;
}

/* ── Skip affordance ──────────────────────────────────────────────────── */

export function SkipLink({ label = 'Skip', onPress }: { label?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button">
      <Text style={styles.skip}>{label}</Text>
    </Pressable>
  );
}

/* ── Shared screen container ──────────────────────────────────────────── */

export function FlowScreen({
  title,
  sub,
  children,
  footer,
  center,
}: {
  title?: string;
  sub?: string;
  children?: React.ReactNode;
  /** Pinned to the bottom (CTAs). */
  footer?: React.ReactNode;
  /** Vertically center the body content. */
  center?: boolean;
}) {
  return (
    <View style={styles.screen}>
      <View style={[{ flex: 1 }, center && { justifyContent: 'center' }]}>
        {title ? (
          <Rise delay={60}>
            <H1>{title}</H1>
          </Rise>
        ) : null}
        {sub ? (
          <Rise delay={160}>
            <Sub>{sub}</Sub>
          </Rise>
        ) : null}
        {children}
      </View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.primary,
  },
  h1: {
    color: theme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 36,
  },
  sub: {
    color: theme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 10,
  },
  skip: {
    color: theme.colors.textTertiary,
    fontSize: 14,
    fontWeight: '600',
  },
  screen: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  footer: {
    paddingBottom: 8,
    paddingTop: 12,
    gap: 10,
  },
});
