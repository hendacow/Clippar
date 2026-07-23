/**
 * MockReel — a looping, fully code-driven stand-in for the hero reel.
 *
 * TODO(remotion-hero): replace the Reanimated composition below with a
 * bundled Remotion-rendered mp4 (e.g. assets/video/hero_reel.mp4, portrait,
 * 5-12s, H.264, hard-compressed) played via expo-video. Keep this component's
 * props/container identical so the swap is one file:
 *
 *   const player = useVideoPlayer(require('@/assets/video/hero_reel.mp4'),
 *     (p) => { p.loop = true; p.muted = true; p.play(); });
 *   return <VideoView player={player} style={...} contentFit="cover" />;
 *
 * Until then: three cross-fading "scenes" (tracer drive → putt drop → end
 * card) built from styled Views + the existing TracerArc. Honest framing —
 * this is presented as *a* reel, never "yours". Respects Reduce Motion by
 * holding on the end card.
 */
import { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withTiming,
  withSequence,
  withRepeat,
  Easing,
  useReducedMotion,
} from 'react-native-reanimated';
import { Play } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { TracerArc } from '../sales/TracerArc';

const SCENE_MS = 2600;

export function MockReel({
  width,
  height,
  courseName,
  playing = true,
}: {
  width: number;
  height: number;
  /** Shown on the end card when the user told us their course. */
  courseName?: string | null;
  playing?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [scene, setScene] = useState(0);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    if (reduceMotion || !playing) {
      setScene(2); // hold on the end card — no auto-cycling motion
      return;
    }
    const t = setInterval(() => {
      setScene((s) => {
        const next = (s + 1) % 3;
        if (next === 0) setReplayKey((k) => k + 1);
        return next;
      });
    }, SCENE_MS);
    return () => clearInterval(t);
  }, [reduceMotion, playing]);

  return (
    <View style={[styles.frame, { width, height }]}>
      {/* fairway-at-dusk backdrop */}
      <LinearGradient
        colors={['#0E2418', '#10261A', '#0A0A0F']}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />

      {scene === 0 ? (
        <Animated.View
          key={`drive-${replayKey}`}
          entering={FadeIn.duration(300)}
          exiting={FadeOut.duration(300)}
          style={StyleSheet.absoluteFill}
        >
          <DriveScene width={width} height={height} replayKey={replayKey} />
        </Animated.View>
      ) : null}

      {scene === 1 ? (
        <Animated.View
          key="putt"
          entering={FadeIn.duration(300)}
          exiting={FadeOut.duration(300)}
          style={StyleSheet.absoluteFill}
        >
          <PuttScene width={width} height={height} />
        </Animated.View>
      ) : null}

      {scene === 2 ? (
        <Animated.View
          key="end"
          entering={FadeIn.duration(300)}
          style={StyleSheet.absoluteFill}
        >
          <EndCard courseName={courseName} />
        </Animated.View>
      ) : null}

      {/* reel chrome */}
      <View style={styles.chrome}>
        <View style={styles.pill}>
          <Play size={10} color="#fff" fill="#fff" />
          <Text style={styles.pillText}>SAMPLE REEL · 0:12</Text>
        </View>
      </View>
    </View>
  );
}

/* ── Scene 1: drive + tracer ─────────────────────────────────────────── */

function DriveScene({
  width,
  height,
  replayKey,
}: {
  width: number;
  height: number;
  replayKey: number;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={StyleSheet.absoluteFill}>
        <TracerArc width={width} height={height * 0.72} replayKey={replayKey} />
      </View>
      <View style={styles.sceneLabelWrap}>
        <Text style={styles.sceneKicker}>HOLE 14 · PAR 5</Text>
        <Text style={styles.sceneTitle}>Driver, flushed</Text>
      </View>
    </View>
  );
}

/* ── Scene 2: the putt drops ─────────────────────────────────────────── */

function PuttScene({ width, height }: { width: number; height: number }) {
  const roll = useSharedValue(0);
  useEffect(() => {
    roll.value = withDelay(
      250,
      withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) })
    );
  }, [roll]);

  const cupX = width * 0.68;
  const cupY = height * 0.42;
  const ball = useAnimatedStyle(() => {
    // Sink into the cup over the last 8% of the roll. Derived directly from
    // roll.value — starting a nested withTiming inside useAnimatedStyle would
    // restart the animation on every frame.
    const sink = roll.value > 0.92 ? Math.max(0, 1 - (roll.value - 0.92) / 0.08) : 1;
    return {
      transform: [
        { translateX: roll.value * (cupX - width * 0.16) },
        { translateY: roll.value * (cupY - height * 0.58) },
        { scale: sink },
      ],
    };
  });

  return (
    <View style={{ flex: 1 }}>
      {/* cup */}
      <View
        style={{
          position: 'absolute',
          left: cupX - 7,
          top: cupY - 4,
          width: 18,
          height: 8,
          borderRadius: 4,
          backgroundColor: '#05130B',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.25)',
        }}
      />
      {/* flag */}
      <View style={{ position: 'absolute', left: cupX + 1, top: cupY - 46, width: 2, height: 44, backgroundColor: 'rgba(255,255,255,0.7)' }} />
      <View style={{ position: 'absolute', left: cupX + 3, top: cupY - 46, width: 14, height: 9, backgroundColor: theme.colors.accentGold }} />
      {/* ball */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: width * 0.16,
            top: height * 0.58,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: '#fff',
          },
          ball,
        ]}
      />
      <View style={styles.sceneLabelWrap}>
        <Text style={styles.sceneKicker}>HOLE 18 · FOR BIRDIE</Text>
        <Text style={styles.sceneTitle}>…and it drops</Text>
      </View>
    </View>
  );
}

/* ── Scene 3: end card ───────────────────────────────────────────────── */

function EndCard({ courseName }: { courseName?: string | null }) {
  const glow = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (reduceMotion) {
      glow.value = 0.5;
      return;
    }
    glow.value = withRepeat(
      withSequence(withTiming(1, { duration: 900 }), withTiming(0.3, { duration: 900 })),
      -1,
      true
    );
  }, [glow, reduceMotion]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.25 + glow.value * 0.35 }));

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: 180,
            height: 180,
            borderRadius: 90,
            backgroundColor: theme.colors.primary,
          },
          halo,
        ]}
      />
      <Image
        source={require('@/assets/images/clippar-logo-stacked.png')}
        style={styles.wordmark}
        resizeMode="contain"
        accessible
        accessibilityRole="image"
        accessibilityLabel="Clippar Golf"
      />
      <Text style={styles.endSub}>{courseName ? courseName : 'Your round, cut to music'}</Text>
      <Text style={styles.endMeta}>18 HOLES · 6 CLIPS · TRACER ON</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#10261A',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  chrome: {
    position: 'absolute',
    top: 10,
    left: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(10,10,15,0.7)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  sceneLabelWrap: {
    position: 'absolute',
    bottom: 14,
    left: 14,
  },
  sceneKicker: {
    color: theme.colors.primaryLight,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  sceneTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
    marginTop: 2,
  },
  wordmark: {
    width: 148,
    height: 96,
  },
  endSub: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  endMeta: {
    color: theme.colors.textTertiary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 4,
  },
});
