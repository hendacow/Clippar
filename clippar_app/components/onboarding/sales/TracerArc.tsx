/**
 * Signature onboarding moment: a gold shot-tracer arc drawing itself across
 * a fairway, a ball riding the tip, haptic kicks at apex and landing. Mirrors
 * the real in-app GPS tracer so the promise == the product.
 *
 * Pure react-native-svg + reanimated: a quadratic Bézier sampled to a
 * polyline whose strokeDashoffset reveals it, with the ball position read off
 * the same progress value.
 */
import { useEffect } from 'react';
import { View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  withTiming,
  withDelay,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import Svg, { Path, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const GOLD = '#F2C14E';
const GOLD_SOFT = '#FFE6A8';

/**
 * Quadratic Bézier point at t. Marked 'worklet' so it can be called from the
 * UI-thread animatedProps (a plain JS function called inside a worklet
 * hard-crashes). Still callable from JS for the path-build loop.
 */
function quad(t: number, p0: number, p1: number, p2: number) {
  'worklet';
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

export function TracerArc({
  width,
  height,
  durationMs = 1400,
  delayMs = 250,
  replayKey = 0,
}: {
  width: number;
  height: number;
  durationMs?: number;
  delayMs?: number;
  replayKey?: number;
}) {
  // Launch bottom-left, apex high-center, land mid-right (telecast look).
  const p0 = { x: width * 0.16, y: height * 0.86 };
  const cp = { x: width * 0.52, y: -height * 0.12 };
  const p3 = { x: width * 0.9, y: height * 0.52 };

  // Build the path + measure its length by sampling.
  const SAMPLES = 60;
  let d = `M ${p0.x} ${p0.y}`;
  let length = 0;
  let prev = p0;
  const pts: { x: number; y: number }[] = [p0];
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const pt = { x: quad(t, p0.x, cp.x, p3.x), y: quad(t, p0.y, cp.y, p3.y) };
    d += ` L ${pt.x} ${pt.y}`;
    length += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
    pts.push(pt);
  }
  // Apex = highest (min y) sample, used to time the apex haptic.
  let apexT = 0.5;
  let minY = Infinity;
  pts.forEach((pt, i) => {
    if (pt.y < minY) {
      minY = pt.y;
      apexT = i / SAMPLES;
    }
  });

  const progress = useSharedValue(0);
  const apexFired = useSharedValue(0);
  const landFired = useSharedValue(0);

  const apexTick = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  const landTick = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  useEffect(() => {
    progress.value = 0;
    apexFired.value = 0;
    landFired.value = 0;
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: durationMs, easing: Easing.out(Easing.cubic) })
    );
  }, [replayKey, delayMs, durationMs, progress, apexFired, landFired]);

  // Haptics via useAnimatedReaction (pure animatedProps below). Firing
  // runOnJS + writing shared values inside useAnimatedProps trips the worklet
  // reentrancy guard and crashes.
  useAnimatedReaction(
    () => progress.value,
    (p) => {
      if (p >= apexT && apexFired.value === 0) {
        apexFired.value = 1;
        runOnJS(apexTick)();
      }
      if (p >= 0.99 && landFired.value === 0) {
        landFired.value = 1;
        runOnJS(landTick)();
      }
    }
  );

  const pathProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - progress.value),
  }));

  const ballProps = useAnimatedProps(() => {
    const t = progress.value;
    return {
      cx: quad(t, p0.x, cp.x, p3.x),
      cy: quad(t, p0.y, cp.y, p3.y),
      opacity: t > 0.02 && t < 0.995 ? 1 : 0,
    };
  });

  return (
    <View pointerEvents="none">
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="tracerGrad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={GOLD} stopOpacity="0.2" />
            <Stop offset="1" stopColor={GOLD} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        {/* Glow underlay */}
        <AnimatedPath
          d={d}
          stroke={GOLD}
          strokeWidth={10}
          strokeOpacity={0.25}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={length}
          animatedProps={pathProps}
        />
        {/* Core stroke */}
        <AnimatedPath
          d={d}
          stroke="url(#tracerGrad)"
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={length}
          animatedProps={pathProps}
        />
        {/* Ball riding the tip */}
        <AnimatedCircle r={6} fill={GOLD_SOFT} animatedProps={ballProps} />
      </Svg>
    </View>
  );
}
