/**
 * Cinematic onboarding (v2) — "watch Henry, then it's your turn".
 *
 * The plan: company-brain org/cto/CINEMATIC_ONBOARDING_PLAN.md. The short of
 * it: a scene machine over REAL footage (bundled, 9 MB — first cold start
 * cannot depend on the update channel) where the fake clicker resolves taps
 * with the REAL shutter window (CLICK_WINDOW_MS from hooks/useShutter), so
 * the muscle memory built here is the production interface: 1 tap =
 * start/stop, 2 = next hole, 3 = penalty.
 *
 * Scenes never own their advancement — the machine does, and every scene has
 * a way forward that doesn't depend on a video finishing (a stalled decode
 * must not wedge onboarding). Skip appears after 3s and hands off to the real
 * "make your first reel" step, not a dead end.
 *
 * v0 status, honestly: functional scene machine, real footage, choreographed
 * haptics, funnel telemetry. NOT yet Duolingo-grade motion — that is the
 * on-device tuning loop with Henry. The EXPORT scene is a placeholder
 * animation until Henry's real screen-recording of posting to his story
 * arrives (it replaces any need for a recreated Instagram UI).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Platform, Animated as RNAnimated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut, useSharedValue, useAnimatedStyle, withTiming, withSpring, withRepeat, withDelay, Easing, runOnJS } from 'react-native-reanimated';
import { CLICK_WINDOW_MS } from '@/hooks/useShutter';
import { logFunnel } from '@/lib/onboardingFunnel';
import { getSetting, setSetting } from '@/lib/storage';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

// Bundled real footage — see assets/onboarding/. montage is 12s cut from a
// real exported reel; shots 1-3 are detector-trimmed swings (~5s each).
const WORDMARK = require('@/assets/images/clippar-logo-wordmark-black.png');

const VIDEOS = {
  // The cold-open hero (plan §13.1/§13.7a): frame 1 is Henry mid-downswing on
  // the last hole's approach; contact lands ~800ms in. Frame-verified cut.
  hero: require('@/assets/onboarding/hero.mp4'),
  shot1: require('@/assets/onboarding/shot1.mp4'),
  shot2: require('@/assets/onboarding/shot2.mp4'),
  shot3: require('@/assets/onboarding/shot3.mp4'),
  // The stitched sample reel doubles as "the exported reel" in the lift-off
  // beat. (The IG story recording is retired from this position per plan
  // §13.4 — the sample is not the viewer's footage, so showing it posted to
  // Henry's real story was dishonest framing. Asset kept on disk, unbundled.)
  reel: require('@/assets/onboarding/sample_reel.mp4'),
} as const;

const SCENES = [
  'MONTAGE',
  'CLICKER_INTRO',
  'RECORD_SHOT',
  'NEXT_HOLE',
  'PENALTY',
  'STORYLINE',
] as const;
export type Scene = (typeof SCENES)[number];

const SCENE_KEY = 'onboarding.v2.scene';

// Max ms a scene may hold the user with no input before offering itself a
// way forward. Generous — this is a wedge guard, not pacing.
const SCENE_TIMEOUT_MS: Record<Scene, number> = {
  MONTAGE: 20_000,
  CLICKER_INTRO: 30_000,
  RECORD_SHOT: 40_000,
  NEXT_HOLE: 30_000,
  PENALTY: 30_000,
  STORYLINE: 45_000,
};

export function CinematicOnboarding({ onDone, onSkip, hook = false }: {
  onDone: () => void;
  onSkip: () => void;
  /** v3 hook mode: montage + one CTA card, nothing else — the theatre's job
   *  is reduced to earning the signup, and the REAL app does the teaching
   *  after it (plan §12). */
  hook?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [scene, setScene] = useState<Scene>('MONTAGE');
  const [showSkip, setShowSkip] = useState(false);
  const sceneStartedAt = useRef(Date.now());
  const sceneRef = useRef<Scene>('MONTAGE');
  sceneRef.current = scene;

  // ---- scene transitions ----------------------------------------------
  // Film-splice cut (plan §13.7): beat changes are an 80ms white flash — the
  // grammar of a video edit, never a screen slide.
  const splice = useSharedValue(0);
  const spliceStyle = useAnimatedStyle(() => ({ opacity: splice.value }));

  const goTo = useCallback((next: Scene) => {
    logFunnel('v2', sceneRef.current, 'complete', Date.now() - sceneStartedAt.current);
    sceneStartedAt.current = Date.now();
    Haptics.selectionAsync();
    splice.value = withTiming(0.9, { duration: 30 }, () => {
      splice.value = withTiming(0, { duration: 50 });
    });
    setScene(next);
    if (!hook) void setSetting(SCENE_KEY, next).catch(() => {});
    logFunnel('v2', next, 'enter', 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = useCallback(() => {
    if (hook) {
      // Hook mode has two beats: MONTAGE, then the CTA card (rendered below
      // as HOOK). Whatever scene asks to advance past the montage goes there;
      // the CTA's button is the only exit.
      if (sceneRef.current === 'MONTAGE') {
        logFunnel('v3', 'MONTAGE', 'complete', Date.now() - sceneStartedAt.current);
        sceneStartedAt.current = Date.now();
        setScene('CLICKER_INTRO'); // reused slot; renders the hook CTA below
        logFunnel('v3', 'HOOK_CTA', 'enter', 0);
      } else {
        logFunnel('v3', 'HOOK_CTA', 'complete', Date.now() - sceneStartedAt.current);
        onDone();
      }
      return;
    }
    const i = SCENES.indexOf(sceneRef.current);
    if (i >= SCENES.length - 1) {
      logFunnel('v2', 'EXPORT', 'complete', Date.now() - sceneStartedAt.current);
      void setSetting(SCENE_KEY, null).catch(() => {});
      onDone();
      return;
    }
    goTo(SCENES[i + 1]);
  }, [goTo, onDone]);

  const skip = useCallback(() => {
    logFunnel('v2', sceneRef.current, 'skip', Date.now() - sceneStartedAt.current);
    void setSetting(SCENE_KEY, null).catch(() => {});
    onSkip();
  }, [onSkip]);

  // Resume a killed run at the top of the scene it died in — never mid-video.
  useEffect(() => {
    logFunnel('v2', 'MONTAGE', 'enter', 0);
    getSetting(SCENE_KEY)
      .then((saved) => {
        if (saved && (SCENES as readonly string[]).includes(saved) && saved !== 'MONTAGE') {
          sceneStartedAt.current = Date.now();
          setScene(saved as Scene);
        }
      })
      .catch(() => {});
    const t = setTimeout(() => setShowSkip(true), 3000);
    return () => clearTimeout(t);
  }, []);

  // Wedge guard: no scene may trap the user forever.
  useEffect(() => {
    const t = setTimeout(advance, SCENE_TIMEOUT_MS[scene]);
    return () => clearTimeout(t);
  }, [scene, advance]);

  if (!isNative || !ExpoVideo) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: '#0A0A0F' }]}>
        <Pressable onPress={onDone}>
          <Text style={{ color: '#fff' }}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: '#000' }]}>
      {scene === 'MONTAGE' && <MontageScene onNext={advance} />}
      {scene === 'CLICKER_INTRO' && (hook ? <HookCtaScene onNext={advance} /> : <ClickerIntroScene onNext={advance} />)}
      {scene === 'RECORD_SHOT' && <RecordShotScene onNext={advance} />}
      {scene === 'NEXT_HOLE' && <MultiTapScene key="nh" taps={2} video={VIDEOS.shot2}
        title="Double-tap = next hole" sub="Two quick taps on the clicker moves your round along." confirm="Hole 2 →" onNext={advance} />}
      {scene === 'PENALTY' && <MultiTapScene key="pen" taps={3} video={VIDEOS.shot3}
        title="Found trouble? Triple-tap" sub="Three taps adds a penalty stroke — honesty, automated." confirm="+1 penalty" onNext={advance} />}
      {scene === 'STORYLINE' && <StorylineScene onNext={advance} />}

      {/* The travelling ball (plan §13.7): one white dot that persists across
          every beat — the putt at rest, the pulse over the clicker, the
          record dot, the full stop. One object followed through a story. */}
      <TravellingBall scene={scene} />

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: '#fff' }, spliceStyle]} />

      {showSkip && (
        <Pressable onPress={skip} hitSlop={12} style={[styles.skip, { top: insets.top + 10 }]}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---- shared bits --------------------------------------------------------

/** Per-scene anchor for the travelling ball, in screen fractions. */
const BALL_ANCHORS: Record<Scene, { x: number; y: number; s: number }> = {
  MONTAGE: { x: 0.5, y: 0.86, s: 1 },        // the ball at rest after the putt
  CLICKER_INTRO: { x: 0.5, y: 0.52, s: 1.4 }, // hovers to the clicker
  RECORD_SHOT: { x: 0.5, y: 0.9, s: 1.2 },    // the record dot's orbit
  NEXT_HOLE: { x: 0.5, y: 0.56, s: 1.2 },
  PENALTY: { x: 0.5, y: 0.56, s: 1.2 },
  STORYLINE: { x: 0.5, y: 0.5, s: 1 },        // rides the stitch
};

function TravellingBall({ scene }: { scene: Scene }) {
  const { width, height } = require('react-native').Dimensions.get('window') as { width: number; height: number };
  const x = useSharedValue(BALL_ANCHORS.MONTAGE.x * width);
  const y = useSharedValue(BALL_ANCHORS.MONTAGE.y * height);
  const sc = useSharedValue(1);
  useEffect(() => {
    const a = BALL_ANCHORS[scene];
    x.value = withSpring(a.x * width, { damping: 16, stiffness: 90 });
    y.value = withSpring(a.y * height, { damping: 16, stiffness: 90 });
    sc.value = withSpring(a.s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value - 5 }, { translateY: y.value - 5 }, { scale: sc.value }],
  }));
  return <Animated.View pointerEvents="none" style={[styles.ball, style]} />;
}

function SceneVideo({ source, playerRef, loop = false, muted = false }: {
  source: number;
  playerRef?: (p: import('expo-video').VideoPlayer) => void;
  loop?: boolean;
  muted?: boolean;
}) {
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(source, (p) => {
    p.loop = loop;
    p.muted = muted;
    p.play();
  });
  useEffect(() => {
    playerRef?.(player);
  }, [player, playerRef]);
  return <VideoView player={player} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />;
}

/** The fake clicker — a big physical-feeling button. Fires the SAME haptic
 *  the real shutter press does. */
function FakeClicker({ onPress, label }: { onPress: () => void; label?: string }) {
  const scale = useRef(new RNAnimated.Value(1)).current;
  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      {label ? <Text style={styles.clickerLabel}>{label}</Text> : null}
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          RNAnimated.sequence([
            RNAnimated.timing(scale, { toValue: 0.85, duration: 70, useNativeDriver: true }),
            RNAnimated.spring(scale, { toValue: 1, useNativeDriver: true }),
          ]).start();
          onPress();
        }}
      >
        <RNAnimated.View style={[styles.clicker, { transform: [{ scale }] }]}>
          <View style={styles.clickerInner} />
        </RNAnimated.View>
      </Pressable>
    </View>
  );
}

// ---- scenes -------------------------------------------------------------

function HookCtaScene({ onNext }: { onNext: () => void }) {
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: '#0A0A0F', padding: 32 }]}>
      <Animated.View entering={FadeIn.duration(400)} style={{ alignItems: 'center', gap: 16 }}>
        <Text style={styles.h1}>Every round, a reel.</Text>
        <Text style={styles.sub}>
          Film every shot with one click. We cut the round into a highlight
          reel — no editing, ever. Set up your account and we'll walk you
          through your first one, in the real app.
        </Text>
        <Pressable onPress={onNext} style={[styles.cta, { marginTop: 20 }]}>
          <Text style={styles.ctaText}>Get started — it's free</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** One silent demonstration of the press — scale in, dip, fade. No haptic:
 *  the user didn't do it (plan §13.7c). Then it waits forever patiently. */
function GhostRing() {
  const sc = useSharedValue(1.3);
  const op = useSharedValue(0);
  useEffect(() => {
    op.value = withDelay(600, withTiming(0.3, { duration: 200 }));
    sc.value = withDelay(600, withTiming(1.0, { duration: 400 }, () => {
      sc.value = withTiming(0.92, { duration: 100 }, () => {
        sc.value = withTiming(1.05, { duration: 150 });
        op.value = withDelay(150, withTiming(0, { duration: 300 }));
      });
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: op.value, transform: [{ scale: sc.value }] }));
  return <Animated.View pointerEvents="none" style={[styles.ghostRing, st]} />;
}

function MontageScene({ onNext }: { onNext: () => void }) {
  // Henry's spec (plan §13.7 rev 2 Sep): the hero is the last hole, four
  // shots from the tee (drive → approach → chip → putt). Over it, the line
  // "Every shot remembered" arrives ONE WORD AT A TIME with a haptic as each
  // slams in; the words and the black wordmark then resolve TOGETHER onto the
  // video's end frame. No mid-clip value lines any more.
  const WORDS = ['Every', 'shot', 'remembered'];
  const [wordCount, setWordCount] = useState(0);
  const [resolved, setResolved] = useState(false);
  const pRef = useRef<import('expo-video').VideoPlayer | null>(null);
  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(1.4);
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  // Slam the words in across the first ~2.4s — each with its own Heavy tick.
  useEffect(() => {
    const timers = WORDS.map((_, i) =>
      setTimeout(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setWordCount(i + 1);
      }, 700 + i * 850)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch the clip: when it reaches its final frame, hold there and resolve
  // the wordmark in alongside the (already-shown) words. onNext fires after
  // a beat on that end frame — "words, logo, and the video end… like that".
  useEffect(() => {
    const iv = setInterval(() => {
      const p = pRef.current;
      if (!p || p.duration <= 0) return;
      if (!resolved && p.currentTime >= p.duration - 0.25) {
        setResolved(true);
        p.pause();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        logoOpacity.value = withTiming(1, { duration: 300 });
        logoScale.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.back(1.6)) });
        setTimeout(onNext, 1400);
      }
    }, 120);
    return () => clearInterval(iv);
  }, [resolved, onNext, logoOpacity, logoScale]);

  return (
    <View style={styles.fill}>
      <SceneVideo source={VIDEOS.hero} playerRef={(p) => (pRef.current = p)} />
      {/* Logo + words TOGETHER at the top (Henry's end-frame screenshot): the
          black wordmark resolves in above the line, and "Every shot
          remembered" builds one word at a time beneath it — both held on the
          video's final frame. */}
      <View style={styles.topStack} pointerEvents="none">
        <Animated.View style={logoStyle}>
          <Image source={WORDMARK} style={styles.wordmark} resizeMode="contain" />
        </Animated.View>
        <Text style={styles.bigWord}>{WORDS.slice(0, wordCount).join(' ')}</Text>
      </View>
    </View>
  );
}

function ClickerIntroScene({ onNext }: { onNext: () => void }) {
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: '#0A0A0F', padding: 32 }]}>
      <Animated.View entering={FadeIn.duration(400)} style={{ alignItems: 'center', gap: 18 }}>
        <Text style={styles.h1}>Let's make your first reel</Text>
        <Text style={styles.sub}>
          On the course, a clicker on your glove records everything.{'\n'}This is it. Give it a press.
        </Text>
        <View style={{ marginTop: 30 }}>
          <FakeClicker onPress={onNext} />
        </View>
      </Animated.View>
    </View>
  );
}

function RecordShotScene({ onNext }: { onNext: () => void }) {
  // Freeze-frame IS the held-at-address shot (Henry's insight): the player
  // starts paused on frame one, resumes on the clicker tap, drops to 0.5x
  // after the strike. No purpose-filmed footage required.
  const [phase, setPhase] = useState<'address' | 'rolling' | 'slowmo'>('address');
  const pRef = useRef<import('expo-video').VideoPlayer | null>(null);
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(VIDEOS.shot1, (p) => {
    p.loop = false;
    p.pause(); // frame one = Henry at address, held until the tap
  });
  pRef.current = player;

  useEffect(() => {
    if (phase !== 'rolling') return;
    const iv = setInterval(() => {
      const p = pRef.current;
      if (!p || p.duration <= 0) return;
      if (p.currentTime >= p.duration * 0.55) {
        p.playbackRate = 0.5;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), 90);
        setPhase('slowmo');
      }
    }, 100);
    return () => clearInterval(iv);
  }, [phase]);

  const onClicker = useCallback(() => {
    if (phase === 'address') {
      player.play();
      setPhase('rolling');
    } else {
      // Stop — same as the real screen: press ends the clip.
      player.pause();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onNext();
    }
  }, [phase, player, onNext]);

  return (
    <View style={styles.fill}>
      <VideoView player={player} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />
      {/* Live-recording chrome, same visual grammar as the real screen */}
      {/* REC sits BESIDE the hole chip — top-right belongs to the parent's
          Skip button, and the two overlapped in the first sim pass. */}
      <View style={styles.hudTop}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={styles.hudChip}><Text style={styles.hudChipText}>Hole 1 · Par 4</Text></View>
          {phase !== 'address' && (
            <View style={[styles.hudChip, { backgroundColor: 'rgba(229,57,53,0.9)' }]}>
              <Text style={styles.hudChipText}>● REC</Text>
            </View>
          )}
        </View>
      </View>
      {phase === 'slowmo' && (
        <Animated.View entering={FadeIn.duration(250)} style={styles.slowmoWrap}>
          <Text style={styles.beatText}>Slow-mo on the strike. Automatic.</Text>
        </Animated.View>
      )}
      <View style={styles.clickerDock}>
        {phase === 'address' && <GhostRing />}
        <FakeClicker
          onPress={onClicker}
          label={phase === 'address' ? 'Press the clicker to start recording' : phase === 'slowmo' ? 'Press again to stop' : undefined}
        />
      </View>
    </View>
  );
}

/** Teaches double/triple tap using the REAL click window: taps are counted
 *  and resolved after CLICK_WINDOW_MS of quiet, exactly like useShutter. */
function MultiTapScene({ taps, video, title, sub, confirm, onNext }: {
  taps: 2 | 3; video: number; title: string; sub: string; confirm: string; onNext: () => void;
}) {
  const [state, setState] = useState<'prompt' | 'confirmed'>('prompt');
  const [hint, setHint] = useState<string | null>(null);
  const count = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = useCallback(() => {
    const n = count.current;
    count.current = 0;
    if (n === taps) {
      if (taps === 3) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), 120);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setState('confirmed');
      setTimeout(onNext, 1800);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setHint(n < taps ? `That was ${n} — try ${taps} quick taps` : `That was ${n} — just ${taps} taps`);
    }
  }, [taps, onNext]);

  const onClicker = useCallback(() => {
    setHint(null);
    count.current += 1;
    if (timer.current) clearTimeout(timer.current);
    // The production window, verbatim. What they learn here is what works.
    timer.current = setTimeout(resolve, CLICK_WINDOW_MS);
  }, [resolve]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <View style={styles.fill}>
      <SceneVideo source={video} loop muted />
      <View style={styles.dim} />
      <View style={[styles.fill, styles.center, { padding: 32 }]}>
        {state === 'prompt' ? (
          <Animated.View entering={FadeIn.duration(350)} style={{ alignItems: 'center', gap: 14 }}>
            <Text style={styles.h1}>{title}</Text>
            <Text style={styles.sub}>{sub}</Text>
            {hint && <Text style={styles.hint}>{hint}</Text>}
            <View style={{ marginTop: 26 }}>
              <FakeClicker onPress={onClicker} />
            </View>
          </Animated.View>
        ) : taps === 2 ? (
          <HoleFlip />
        ) : (
          <PenaltyChip />
        )}
      </View>
    </View>
  );
}

/** Scoreboard flip: the old hole digit exits up, the new one springs in
 *  from below — state change as the confirmation, not a caption. */
function HoleFlip() {
  const oldY = useSharedValue(0);
  const oldOp = useSharedValue(1);
  const newY = useSharedValue(24);
  const newOp = useSharedValue(0);
  useEffect(() => {
    oldY.value = withTiming(-24, { duration: 220 });
    oldOp.value = withTiming(0, { duration: 220 });
    newY.value = withDelay(120, withSpring(0, { damping: 14 }));
    newOp.value = withDelay(120, withTiming(1, { duration: 180 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const oldSt = useAnimatedStyle(() => ({ opacity: oldOp.value, transform: [{ translateY: oldY.value }] }));
  const newSt = useAnimatedStyle(() => ({ opacity: newOp.value, transform: [{ translateY: newY.value }] }));
  return (
    <View style={styles.confirmCard}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={styles.confirmText}>Hole</Text>
        <View style={{ width: 26, height: 30 }}>
          <Animated.Text style={[styles.confirmText, { position: 'absolute' }, oldSt]}>1</Animated.Text>
          <Animated.Text style={[styles.confirmText, { position: 'absolute' }, newSt]}>2</Animated.Text>
        </View>
      </View>
    </View>
  );
}

/** The +1 chip drops onto the card with spring overshoot and a slight
 *  un-rotate — consequence, not caption (plan §13.7c). */
function PenaltyChip() {
  const y = useSharedValue(-40);
  const rot = useSharedValue(-8);
  const op = useSharedValue(0);
  useEffect(() => {
    op.value = withTiming(1, { duration: 120 });
    y.value = withSpring(0, { damping: 11, stiffness: 160 });
    rot.value = withSpring(0, { damping: 12 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = useAnimatedStyle(() => ({
    opacity: op.value,
    transform: [{ translateY: y.value }, { rotate: `${rot.value}deg` }],
  }));
  return (
    <Animated.View style={[styles.penaltyChip, st]}>
      <Text style={styles.confirmText}>+1 penalty</Text>
    </Animated.View>
  );
}

function StorylineScene({ onNext }: { onNext: () => void }) {
  // "Create your own reel" as ONE continuous storyline (Henry, 2 Sep). His
  // beats, in order: four shots sit at the bottom → they move over each other
  // in the middle → vibrate → become one, all with the narration —
  // "recorded videos are long and hard to edit" → "AI trims everything into
  // the few seconds that matter" → the trimmer shortens to the 3s that
  // matter → the stitch → reel ready to share. Built from his real par-5
  // clips (posters for the pieces, the offline-stitched reel for the payoff).
  type Beat = 'gather' | 'merge' | 'trim' | 'stitch' | 'reel';
  const [beat, setBeat] = useState<Beat>('gather');
  const SAMPLE_POSTERS = [
    require('@/assets/onboarding/sample1_poster.jpg'),
    require('@/assets/onboarding/sample2_poster.jpg'),
    require('@/assets/onboarding/sample3_poster.jpg'),
    require('@/assets/onboarding/sample4_poster.jpg'),
  ];

  // Four tiles: from a row along the bottom, into a converging stack in the
  // middle, vibrate, then collapse into one.
  const converge = useSharedValue(0); // 0 = spread at bottom, 1 = stacked centre
  const buzz = useSharedValue(0);
  const merge = useSharedValue(0);    // 0 = four tiles, 1 = fused single
  const trimW = useSharedValue(1);    // 1 = full, → 0.32 (the 3s that matter)
  const reelScale = useSharedValue(0.9);
  const reelOpacity = useSharedValue(0);

  const { useVideoPlayer, VideoView } = ExpoVideo ?? { useVideoPlayer: null, VideoView: null };
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const player = ExpoVideo ? ExpoVideo.useVideoPlayer(VIDEOS.reel, (p) => { p.loop = true; p.muted = true; }) : null;

  useEffect(() => {
    // gather → merge
    converge.value = withDelay(300, withTiming(1, { duration: 900, easing: Easing.inOut(Easing.cubic) }, (f) => {
      if (f) runOnJS(setBeat)('merge');
    }));
    // buzz + fuse
    buzz.value = withDelay(1400, withRepeat(withTiming(1, { duration: 60 }), 8, true));
    merge.value = withDelay(1400, withTiming(1, { duration: 700 }, (f) => {
      if (f) {
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Heavy);
        runOnJS(setBeat)('trim');
      }
    }));
    // trim down to the 3s that matter
    trimW.value = withDelay(2600, withTiming(0.32, { duration: 900, easing: Easing.out(Easing.cubic) }, (f) => {
      if (f) runOnJS(setBeat)('stitch');
    }));
    // stitch → reel
    reelOpacity.value = withDelay(4000, withTiming(1, { duration: 400 }));
    reelScale.value = withDelay(4000, withTiming(1, { duration: 500 }, (f) => {
      if (f) {
        runOnJS(setBeat)('reel');
        if (player) runOnJS(playReel)();
      }
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function playReel() {
    player?.play();
  }

  const NARRATION: Record<Beat, string> = {
    gather: 'Recorded videos are long and hard to edit.',
    merge: 'Recorded videos are long and hard to edit.',
    trim: 'AI trims everything into the few seconds that matter.',
    stitch: 'Then stitches them into one reel.',
    reel: 'Reel ready to share.',
  };

  const tileStyle = (i: number) =>
    useAnimatedStyle(() => {
      const spreadX = (i - 1.5) * 92; // bottom row spacing
      const x = spreadX * (1 - converge.value);
      const y = (1 - converge.value) * 230; // start low, rise to centre
      const jitter = buzz.value * (i % 2 === 0 ? 3 : -3);
      const w = i === 0 ? 84 : 84 * (1 - merge.value); // others collapse into the first
      return {
        opacity: i === 0 ? 1 : 1 - merge.value,
        width: Math.max(2, i === 0 ? 84 * trimW.value * 1 + 84 * (1 - trimW.value) * 0 + 84 : w) === 0 ? 2 : (i === 0 ? 84 : w),
        transform: [{ translateX: x + jitter }, { translateY: y }],
      };
    });

  // The surviving tile also carries the trim shave once merged.
  const firstTileWidth = useAnimatedStyle(() => ({ width: 84 }));

  return (
    <View style={[styles.fill, { backgroundColor: '#0A0A0F' }]}>
      {beat === 'reel' && player && VideoView ? (
        <Animated.View style={[StyleSheet.absoluteFillObject, useAnimatedStyle(() => ({ opacity: reelOpacity.value, transform: [{ scale: reelScale.value }] }))]}>
          <VideoView player={player} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />
        </Animated.View>
      ) : (
        <View style={[styles.fill, styles.center]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 140 }}>
            {SAMPLE_POSTERS.map((src, i) => (
              <Animated.View key={i} style={[styles.storyTile, tileStyle(i), i === 0 && beat === 'trim' ? { overflow: 'hidden' } : null]}>
                <Image source={src} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </Animated.View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.narrationWrap} pointerEvents="none">
        <Animated.Text key={NARRATION[beat]} entering={FadeIn.duration(300)} style={styles.narration}>
          {NARRATION[beat]}
        </Animated.Text>
      </View>

      {beat === 'reel' && (
        <Animated.View entering={FadeIn.duration(400)} style={styles.storyCta}>
          <Pressable onPress={onNext} style={styles.cta}>
            <Text style={styles.ctaText}>Now make YOURS</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}


const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  skip: { position: 'absolute', right: 16, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  skipText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600' },
  h1: { color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center' },
  sub: { color: 'rgba(255,255,255,0.75)', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  hint: { color: '#FFD54F', fontSize: 14, fontWeight: '600' },
  slowmoWrap: { position: 'absolute', top: 130, left: 24, right: 24, alignItems: 'center' },
  beatWrap: { position: 'absolute', bottom: 130, left: 24, right: 24, alignItems: 'center' },
  beatText: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8 },
  brandWrap: { position: 'absolute', top: 70, left: 0, right: 0, alignItems: 'center' },
  wordmark: { width: 200, height: 58 },
  topStack: { position: 'absolute', top: 70, left: 24, right: 24, alignItems: 'center', gap: 14 },
  bigWord: { color: '#fff', fontSize: 26, fontWeight: '900', textAlign: 'center', letterSpacing: 0.5, textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 10 },
  ghostRing: { position: 'absolute', bottom: -6, width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: '#fff' },
  ball: { position: 'absolute', top: 0, left: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', shadowColor: '#fff', shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  clicker: { width: 84, height: 84, borderRadius: 42, backgroundColor: '#1B5E20', borderWidth: 4, borderColor: '#4CAF50', alignItems: 'center', justifyContent: 'center', shadowColor: '#4CAF50', shadowOpacity: 0.6, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  clickerInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#4CAF50' },
  clickerLabel: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 6 },
  clickerDock: { position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' },
  hudTop: { position: 'absolute', top: 60, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' },
  hudChip: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  hudChipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  storyTile: { height: 132, marginHorizontal: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)' },
  narrationWrap: { position: 'absolute', bottom: 150, left: 24, right: 24, alignItems: 'center' },
  narration: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8 },
  storyCta: { position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' },
  penaltyChip: { backgroundColor: 'rgba(211,47,47,0.95)', borderRadius: 18, paddingHorizontal: 28, paddingVertical: 18 },
  confirmCard: { backgroundColor: 'rgba(76,175,80,0.95)', borderRadius: 18, paddingHorizontal: 28, paddingVertical: 18 },
  confirmText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  progressTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#4CAF50' },
  slotRow: { position: 'absolute', bottom: 90, flexDirection: 'row', gap: 14 },
  appSlot: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.12)' },
  reelCard: { width: '100%', height: '100%', overflow: 'hidden' },
  exampleBadge: { borderWidth: 1.5, borderColor: '#FFD54F', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  exampleFloat: { position: 'absolute', top: 64, alignSelf: 'center', backgroundColor: 'rgba(10,10,15,0.75)' },
  exampleBadgeText: { color: '#FFD54F', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  cta: { backgroundColor: '#4CAF50', borderRadius: 16, paddingHorizontal: 30, paddingVertical: 16, marginTop: 12 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
