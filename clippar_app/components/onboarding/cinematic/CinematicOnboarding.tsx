/**
 * Cinematic onboarding (v2) — "watch Henry, then it's your turn".
 *
 * The plan: company-brain org/cto/CINEMATIC_ONBOARDING_PLAN.md. The short of
 * it: a scene machine over REAL footage (bundled — first cold start cannot
 * depend on the update channel). 3 Sep shape, Henry's: the hero with the
 * line fading in and looping under a CTA → the recording lesson on the REAL
 * record-screen chrome (press to start, press to stop, End Round) → the
 * trim/stitch storyline → share → his exported reel at 5x → signup. The
 * double/triple-tap lessons were cut; the real screen still teaches them.
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
import { View, Text, Image, Pressable, StyleSheet, Platform, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, useSharedValue, useAnimatedStyle, withTiming, withSpring, withRepeat, withSequence, withDelay, Easing, runOnJS } from 'react-native-reanimated';
import { Flag, AlertTriangle, ChevronLeft, ChevronRight, Bluetooth, Settings2, SwitchCamera, X, Heart, Send } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { ScoreOverlay } from '@/components/record/ScoreOverlay';
import { RecordingIndicator } from '@/components/record/RecordingIndicator';
import { logFunnel } from '@/lib/onboardingFunnel';
import { getSetting, setSetting } from '@/lib/storage';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

// Bundled real footage — see assets/onboarding/. montage is 12s cut from a
// real exported reel; shots 1-3 are detector-trimmed swings (~5s each).
// The real stacked lockup — C-with-flag mark, CLIPPAR, GOLF letterspaced
// beneath — NOT a typeface set to resemble it.
//
// WHITE, and that was a measured decision, not a preference. On this end
// frame's sky the BLACK variant put CLIPPAR at 7.32:1 but the green GOLF at
// 1.43:1, where large text needs 3.0:1. Black wants a bright background and
// the green wants a dark one, so a scrim trades one for the other and only a
// single 5%-wide window cleared 3.0:1 on both — with nothing to spare.
// White removes the conflict entirely: white and green both want the same
// dark ground, so the scrim helps both at once.
// DO NOT swap this back to the black variant without re-measuring; it looks
// like a harmless brand choice and it is not.
// Artwork as supplied; its green is #A4C71C, not the site's CSS #A8E63D.
const WORDMARK = require('@/assets/images/clippar-logo-stacked-white.png');

const VIDEOS = {
  // The hero: the last hole, four shots from the tee. 3 Sep: first 0.2s
  // dropped — it carried a sliver of the previous shot — so frame 1 is Henry
  // at address at sunset (frame-verified on the simulator). 14.85s, loops.
  hero: require('@/assets/onboarding/hero.mp4'),
  // The recording lesson's clip: Henry's putt (archived sample5 from 3.5s):
  // frame 1 at address, the stroke ~2s in, the ball rolling out. Natural
  // sound KEPT — Henry wants the noise of the shot. 4 Sep: the first clip
  // was another golfer; the second had a friend talking over its tail
  // (loudness rises again at 5.0s in that file); this one's audio is flat
  // ambient with the stroke, measured, no speech-shaped stretch.
  lesson: require('@/assets/onboarding/lesson_shot.mp4'),
  // Henry's exported reel at 5x (75s → 15s) under the hero's own music track,
  // which is 15.0s — they fit to the frame. The last thing seen before signup.
  demo: require('@/assets/onboarding/demo_reel.mp4'),
  // The stitched sample reel doubles as "the exported reel" in the lift-off
  // beat. (The IG story recording is retired from this position per plan
  // §13.4 — the sample is not the viewer's footage, so showing it posted to
  // Henry's real story was dishonest framing. Asset kept on disk, unbundled.)
  reel: require('@/assets/onboarding/sample_reel.mp4'),
} as const;

// Landscape frame for the trimmer card. NOTE: the card's Image must be sized
// with width/height '100%', NOT absoluteFillObject — under absoluteFill it
// lays out at its intrinsic 1080x760 anchored top-left and the card clips to
// the photo's top-left corner (sky and trees), whatever photo you put in it.
// That, not the choice of still, was the "trees instead of a golfer" bug.
const TRIM_FRAME = require('@/assets/onboarding/trim_frame.jpg');
// Henry's share mock (Reel · Post · Story · Message), its grey ground
// replaced with the app black so it sits flush on the SHARE scene.
const SHARE_MOCK = require('@/assets/onboarding/share_socials.png');

// 3 Sep (Henry): montage → the REAL recording screen → the trim/stitch
// storyline → share → the demo reel → signup. Double/triple-tap lessons cut.
const SCENES = [
  'MONTAGE',
  'RECORD',
  'STORYLINE',
  'SHARE',
  'DEMO_REEL',
] as const;
export type Scene = (typeof SCENES)[number];

const SCENE_KEY = 'onboarding.v2.scene';

// Max ms a scene may hold the user with no input before offering itself a
// way forward. Generous — this is a wedge guard, not pacing.
const SCENE_TIMEOUT_MS: Record<Scene, number> = {
  MONTAGE: 120_000, // loops under the CTA by design; this is only the wedge guard
  RECORD: 60_000,
  STORYLINE: 45_000,
  SHARE: 15_000,
  DEMO_REEL: 40_000,
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
        setScene('RECORD'); // reused slot; renders the hook CTA below
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
      {scene === 'RECORD' && (hook ? <HookCtaScene onNext={advance} /> : <RecordScene onNext={advance} topInset={insets.top} bottomInset={insets.bottom} />)}
      {scene === 'STORYLINE' && <StorylineScene onNext={advance} />}
      {scene === 'SHARE' && <ShareScene onNext={advance} />}
      {scene === 'DEMO_REEL' && <DemoReelScene onNext={advance} />}

      {/* The travelling ball (plan §13.7): one white dot that persists across
          every beat — the putt at rest, the pulse over the clicker, the
          record dot, the full stop. One object followed through a story. */}
      <TravellingBall scene={scene} />

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: '#fff' }, spliceStyle]} />

      {/* On the RECORD scene the real ScoreOverlay owns top-right (Shot chip at
          +8, End Round at +52), so Skip drops to +92 — the slot Options uses on
          the left — rather than sit on the Shot chip, which it did. */}
      {showSkip && (
        <Pressable onPress={skip} hitSlop={12} style={[styles.skip, { top: insets.top + (scene === 'RECORD' ? 92 : 10) }]}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---- shared bits --------------------------------------------------------

/** Per-scene anchor for the travelling ball, in screen fractions. */
const BALL_ANCHORS: Record<Scene, { x: number; y: number; s: number }> = {
  MONTAGE: { x: 0.5, y: 0.86, s: 1 },     // the ball at rest after the putt
  RECORD: { x: 0.5, y: 0.9, s: 0 },       // hidden: nothing may sit on the real chrome
  STORYLINE: { x: 0.5, y: 0.5, s: 1 },    // rides the stitch
  SHARE: { x: 0.5, y: 0.5, s: 0 },
  DEMO_REEL: { x: 0.5, y: 0.9, s: 0 },
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

function MontageScene({ onNext }: { onNext: () => void }) {
  // Henry's spec (plan §13.7 rev 2 Sep): the hero is the last hole, four
  // shots from the tee (drive → approach → chip → putt). Over it, the line
  // "Every shot remembered" arrives ONE WORD AT A TIME with a haptic as each
  // slams in; the words and the black wordmark then resolve TOGETHER onto the
  // video's end frame. No mid-clip value lines any more.
  // The website treatment: two stacked lines, heavy condensed uppercase, with
  // "REMEMBERED." in the brand green. Three stamps, the last one landing on
  // its own line.
  const WORDS = ['EVERY', 'SHOT.', 'REMEMBERED.'];
  // 3 Sep (Henry): the words FADE in, and the whole line + logo must be
  // finished on screen 3s before the clip ends. The clip then LOOPS under
  // them, and "Let's create your reel" at the bottom is the only way on —
  // no auto-advance. Last word lands at 260 + 2×620ms and fades WORD_FADE_MS,
  // so the sequence starts that much earlier than the 3s mark.
  const WORDS_DONE_BEFORE_END_S = 3;
  const WORD_FADE_MS = 400;
  // Measured on the simulator (3 Sep, frame-timed burst): the sequence lands
  // ~0.7s after the clock says it should — currentTime is polled at 120ms and
  // the player reports late — which left the line finished 2.2s before the
  // end, not 3. This is that allowance; re-measure if the poll changes.
  const WORD_TRIGGER_LATENCY_S = 0.8;
  const WORDS_LEAD_S = WORDS_DONE_BEFORE_END_S + (260 + 2 * 620 + WORD_FADE_MS) / 1000 + WORD_TRIGGER_LATENCY_S;
  const [wordCount, setWordCount] = useState(0);
  const [resolved, setResolved] = useState(false);
  const [ctaReady, setCtaReady] = useState(false);
  const pRef = useRef<import('expo-video').VideoPlayer | null>(null);
  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(1.4);
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  // The stamps fire on the END FRAME, not during the clip — Henry's "should
  // stamp in one word at a time at the very end". They used to run in the
  // first 2.4s and were long finished before the video stopped.
  useEffect(() => {
    if (!resolved) return;
    const timers = WORDS.map((_, i) =>
      setTimeout(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setWordCount(i + 1);
      }, 260 + i * 620)
    );
    // The CTA arrives once the line is complete — never over a half-built line.
    timers.push(setTimeout(() => setCtaReady(true), 260 + 2 * 620 + WORD_FADE_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  // Watch the clip: when it reaches its final frame, hold there and resolve
  // the wordmark in alongside the (already-shown) words. onNext fires after
  // a beat on that end frame — "words, logo, and the video end… like that".
  useEffect(() => {
    const iv = setInterval(() => {
      const p = pRef.current;
      if (!p || p.duration <= 0) return;
      if (!resolved && p.currentTime >= p.duration - WORDS_LEAD_S) {
        setResolved(true);
        // The clip keeps running to its end and loops (SceneVideo loop) —
        // the line and logo stay up over it until the CTA is pressed.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        logoOpacity.value = withTiming(1, { duration: 300 });
        logoScale.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.back(1.6)) });
      }
    }, 120);
    return () => clearInterval(iv);
  }, [resolved, logoOpacity, logoScale]);

  return (
    <View style={styles.fill}>
      <SceneVideo source={VIDEOS.hero} loop playerRef={(p) => (pRef.current = p)} />
      {/* Title scrim. MEASURED, not judged by eye.

          With the WHITE lockup the old black-vs-green tension is gone: white
          and green both want a dark ground, so the scrim helps both at once
          and there is no knife-edge value any more. It runs 380pt — far
          enough to carry the two-line headline, which sits much lower and
          larger than the old single line, and finished before it reaches the
          golfer so the frame Henry wanted to end on survives.

          Kept for whoever revisits this: with the BLACK lockup the same sky
          gave CLIPPAR 7.32:1 and GOLF 1.43:1, and only one 5%-wide scrim
          window cleared 3.0:1 on both. Do not reintroduce black here without
          re-measuring. And never "fix" faint green with the dim green
          #6FA828 — against this sky it measures 1.00:1 and vanishes. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0.72)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']}
        locations={[0, 0.72, 1]}
        style={styles.titleScrim}
      />
      {/* Logo + words TOGETHER at the top (Henry's end-frame screenshot): the
          black wordmark resolves in above the line, and "Every shot
          remembered" builds one word at a time beneath it — both held on the
          video's final frame. */}
      <View style={styles.topStack} pointerEvents="none">
        <Animated.View style={logoStyle}>
          <Image source={WORDMARK} style={styles.wordmark} resizeMode="contain" />
        </Animated.View>
        <View style={{ alignItems: 'center' }}>
          <View style={{ flexDirection: 'row' }}>
            {WORDS.slice(0, Math.min(wordCount, 2)).map((w, i) => (
              <Animated.Text
                key={w}
                entering={FadeIn.duration(WORD_FADE_MS)}
                style={[styles.bigWord, i === 1 && { marginLeft: 12 }]}
              >
                {w}
              </Animated.Text>
            ))}
          </View>
          {wordCount >= 3 && (
            <Animated.Text
              entering={FadeIn.duration(WORD_FADE_MS)}
              style={[styles.bigWord, styles.bigWordGreen]}
            >
              {WORDS[2]}
            </Animated.Text>
          )}
        </View>
      </View>
      {ctaReady && (
        <Animated.View entering={FadeIn.duration(400)} style={styles.storyCta}>
          <Pressable onPress={onNext} style={styles.cta}>
            <Text style={styles.ctaText}>Let's create your reel</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

/** The recording lesson on the REAL interface (3 Sep, Henry: "look
 *  identical to the real recording screen"). Same chrome as
 *  app/(tabs)/record.tsx — the real ScoreOverlay and RecordingIndicator,
 *  the shutter badge, Options and End Round pills, the camera-controls row
 *  and the Penalty · record · Prev/Next Hole row — with Henry's footage
 *  where the camera preview would be. Everything is inert except the record
 *  button and, once a clip is saved, End Round.
 *
 *  Freeze-frame IS the held-at-address shot: the player starts paused on
 *  frame one and rolls on the press. No slow-mo on the strike — the real
 *  app does not do that, so the lesson must not either (Henry, 4 Sep). */
function RecordScene({ onNext, topInset, bottomInset }: { onNext: () => void; topInset: number; bottomInset: number }) {
  type Phase = 'address' | 'rolling' | 'stopped';
  const [phase, setPhase] = useState<Phase>('address');
  const pRef = useRef<import('expo-video').VideoPlayer | null>(null);
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(VIDEOS.lesson, (p) => {
    p.loop = false;
    p.muted = false; // the sound of the shot stays (Henry, 4 Sep)
    p.pause(); // frame one = Henry at address, held until the tap
  });
  pRef.current = player;

  const isRecording = phase === 'rolling';

  const onRecordPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (phase === 'address') {
      player.play();
      setPhase('rolling');
    } else if (phase === 'rolling') {
      // Stop — same as the real screen: the press ends the clip.
      player.pause();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase('stopped');
    }
  }, [phase, player]);

  const onEndRound = useCallback(() => {
    if (phase !== 'stopped') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onNext();
  }, [phase, onNext]);

  const coach =
    phase === 'address' ? 'This is your clicker. Press it to start recording.'
    : phase === 'rolling' ? 'Recording. Press again when the shot is done.'
    : 'Shot saved. Now end the round.';
  const armed = phase === 'stopped';
  const pillColor = armed ? '#fff' : theme.colors.textSecondary;

  return (
    <View style={[styles.fill, { backgroundColor: '#000' }]}>
      <VideoView player={player} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />

      {/* Top chrome — the real components, real offsets. */}
      <ScoreOverlay holeNumber={1} par={4} currentShot={armed ? 2 : 1} scoreToPar={0} isRecording={isRecording} topInset={topInset} />
      <View style={[styles.recPill, { top: topInset + 52, left: 12 }]}>
        <Bluetooth size={12} color={theme.colors.connected} />
        <Text style={[styles.recPillText, { color: theme.colors.connected }]}>Clicker</Text>
      </View>
      <View style={[styles.recPill, { top: topInset + 92, left: 12 }]}>
        <Settings2 size={12} color={theme.colors.textSecondary} />
        <Text style={[styles.recPillText, { color: theme.colors.textSecondary }]}>Options</Text>
      </View>
      <Pressable onPress={onEndRound} hitSlop={8} style={[styles.recPill, { top: topInset + 52, right: 12 }, armed && styles.recPillArmed]}>
        <Flag size={12} color={pillColor} />
        <Text style={[styles.recPillText, { color: pillColor }]}>End Round</Text>
      </Pressable>

      {/* The coach line sits just above the controls, scrimmed. */}
      <Animated.View key={coach} entering={FadeIn.duration(250)} pointerEvents="none" style={[styles.coachBand, { bottom: bottomInset + 190 }]}>
        <Text style={styles.coachText}>{coach}</Text>
      </Animated.View>

      {/* Bottom controls — same two rows as the real screen. */}
      <View style={[styles.recBottom, { paddingBottom: bottomInset + 16 }]}>
        <View style={styles.recCameraRow}>
          <View style={styles.recZoomToggle}>
            {(['0.5x', '1x'] as const).map((m) => (
              <View key={m} style={[styles.recZoomPill, m === '1x' && styles.recZoomPillActive]}>
                <Text style={[styles.recZoomText, m === '1x' && { color: '#fff' }]}>{m}</Text>
              </View>
            ))}
          </View>
          <View style={styles.recFlip}>
            <SwitchCamera size={20} color="#fff" />
          </View>
        </View>
        <View style={styles.recActionRow}>
          <View style={styles.recActionBtn}>
            <AlertTriangle size={16} color="#FF6B6B" />
            <Text style={styles.recActionText}>Penalty</Text>
          </View>
          <Pressable onPress={onRecordPress} style={styles.center}>
            <RecordingIndicator isRecording={isRecording} />
          </Pressable>
          <View style={styles.recHoleNav}>
            <View style={[styles.recHoleBtn, { opacity: 0.35 }]}>
              <ChevronLeft size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.recActionText, { color: theme.colors.textSecondary }]}>Prev</Text>
            </View>
            <View style={styles.recHoleBtn}>
              <ChevronRight size={16} color={theme.colors.primary} />
              <Text style={[styles.recActionText, { color: theme.colors.primary }]}>Next Hole</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/** Share beat (3 Sep): Henry's Reel · Post · Story · Message mock on the app
 *  black. Holds a few seconds, or a tap moves on. */
function ShareScene({ onNext }: { onNext: () => void }) {
  const w = Dimensions.get('window').width - 32;
  const h = Math.round(w * (638 / 1179)); // the mock's own aspect
  useEffect(() => {
    const t = setTimeout(onNext, 3800);
    return () => clearTimeout(t);
  }, [onNext]);
  return (
    <Pressable onPress={onNext} style={[styles.fill, styles.center, { backgroundColor: '#0A0A0F', padding: 16 }]}>
      <Animated.View entering={FadeIn.duration(350)} style={{ alignItems: 'center', gap: 22 }}>
        <Text style={styles.h1}>Share it anywhere</Text>
        <Text style={styles.sub}>Reel, post, story or message — straight from the app.</Text>
        <Image source={SHARE_MOCK} style={{ width: w, height: h, marginTop: 6 }} resizeMode="contain" />
      </Animated.View>
    </Pressable>
  );
}

/** The last thing before signup: Henry's real exported reel at 5x under the
 *  opening video's music, presented INSIDE an Instagram-story frame (3 Sep,
 *  Henry). The story chrome sits ABOVE and BELOW the video, never over it,
 *  and the video is contain-fit — so the reel's own scorecard header, which
 *  a full-bleed cover crop was cutting off, is always whole. This is his own
 *  reel in a story frame, not a sample posted to his story (the thing plan
 *  §13.4 retired). The CTA arrives after a beat so nobody is held. */
function DemoReelScene({ onNext }: { onNext: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = Dimensions.get('window');
  const { useVideoPlayer, VideoView } = ExpoVideo!;
  const player = useVideoPlayer(VIDEOS.demo, (p) => {
    p.loop = true; // Henry, 4 Sep: "make that looping as well once it finishes"
    p.muted = false;
    p.play();
  });
  const [ctaReady, setCtaReady] = useState(false);
  const progress = useSharedValue(0);
  useEffect(() => {
    const t = setTimeout(() => setCtaReady(true), 2500);
    // 15.0s clip, looping — the bar refills each pass.
    progress.value = withRepeat(withTiming(1, { duration: 15000, easing: Easing.linear }), -1, false);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` as unknown as number }));

  // Story chrome heights + the CTA's reserve decide how big the 9:16 video can be.
  const HEAD_H = 44;
  const FOOT_H = 52;
  const top = insets.top + 46;                 // Skip sits above the card at +10
  const reserve = 60 + 64 + 16;                // storyCta bottom + button + gap
  const videoH = Math.floor(Math.min(height - top - reserve - HEAD_H - FOOT_H, ((width - 44) * 16) / 9));
  const videoW = Math.floor((videoH * 9) / 16);

  return (
    <View style={[styles.fill, { backgroundColor: '#0A0A0F', alignItems: 'center' }]}>
      <View style={[styles.storyCard, { width: videoW, marginTop: top }]}>
        <View style={[styles.storyHead, { height: HEAD_H }]}>
          <View style={styles.storyProgress}>
            <Animated.View style={[styles.storyProgressFill, progressStyle]} />
          </View>
          <View style={styles.storyHeadRow}>
            <View style={styles.storyAvatar} />
            <Text style={styles.storyName}>clippar.golf</Text>
            <Text style={styles.storyTime}>1h</Text>
            <View style={{ flex: 1 }} />
            <X size={18} color="#fff" />
          </View>
        </View>
        <VideoView player={player} style={{ width: videoW, height: videoH, backgroundColor: '#000' }} contentFit="contain" nativeControls={false} />
        <View style={[styles.storyFoot, { height: FOOT_H }]}>
          <View style={styles.storyReply}>
            <Text style={styles.storyReplyText}>Send message</Text>
          </View>
          <Heart size={22} color="#fff" />
          <Send size={22} color="#fff" />
        </View>
      </View>
      {ctaReady && (
        <Animated.View entering={FadeIn.duration(400)} style={styles.storyCta}>
          <Pressable onPress={onNext} style={styles.cta}>
            <Text style={styles.ctaText}>Make yours — it's free</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

function StorylineScene({ onNext }: { onNext: () => void }) {
  // "Create your own reel" as ONE continuous storyline, rebuilt to Henry's
  // exact spec (2 Sep): four LARGE shots sit along the bottom → rise and
  // stack over each other in the middle → vibrate → FUSE into one (flash +
  // haptic) → a real TRIMMER with handles closes in to the seconds that
  // matter → stitch → the reel plays, ready to share. His words, and the
  // three things the first pass got wrong: tiles too small/mid-screen, the
  // fuse didn't read, and the "trimmer" was a strip not a trimmer.
  //
  // Rules-of-hooks: every animated style is a top-level hook, fixed count —
  // the crash the sim caught came from a conditional/looped useAnimatedStyle.
  type Beat = 'gather' | 'stack' | 'fuse' | 'trim' | 'stitch' | 'reel';
  const [beat, setBeat] = useState<Beat>('gather');
  const POSTERS = [
    require('@/assets/onboarding/sample1_poster.jpg'),
    require('@/assets/onboarding/sample2_poster.jpg'),
    require('@/assets/onboarding/sample3_poster.jpg'),
    require('@/assets/onboarding/sample4_poster.jpg'),
  ];

  // Timeline drivers.
  const rise = useSharedValue(0);   // 0 = row at bottom, 1 = risen to centre
  const stack = useSharedValue(0);  // 0 = fanned row, 1 = overlapping stack
  const buzz = useSharedValue(0);   // vibration amplitude
  const fuse = useSharedValue(0);   // 0 = four cards, 1 = one card
  const flash = useSharedValue(0);  // white flash at the fuse instant
  const trimL = useSharedValue(0);  // left handle 0→1 closes in
  const trimR = useSharedValue(0);  // right handle 0→1 closes in
  const stitchP = useSharedValue(0);  // 0 = segments apart, 1 = locked into a strip
  const reelOpacity = useSharedValue(0);
  const reelScale = useSharedValue(0.92);

  const { useVideoPlayer, VideoView } = ExpoVideo ?? { useVideoPlayer: null, VideoView: null };
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const player = ExpoVideo ? ExpoVideo.useVideoPlayer(VIDEOS.reel, (p) => { p.loop = true; p.muted = true; }) : null;

  const TILE_W = 128;
  const TILE_H = 184;
  const ROW_GAP = 92; // < TILE_W so the bottom row overlaps into a fan

  // Four tile styles, always declared, fixed order.
  const tileStyle = (i: number) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => {
      const fromX = (i - 1.5) * ROW_GAP;        // fanned row spread
      const x = fromX * (1 - stack.value);       // → 0 as they stack centre
      const y = (1 - rise.value) * 300;          // start 300px low, rise to centre
      const jitter = buzz.value * (i % 2 === 0 ? 4 : -4);
      const rot = (i - 1.5) * 6 * stack.value * (1 - fuse.value); // deck tilt, straightens on fuse
      // Non-lead tiles fade and slide into the lead as they fuse.
      const fadeOut = i === 0 ? 0 : fuse.value;
      return {
        opacity: 1 - fadeOut,
        transform: [
          { translateX: x + jitter - fromX * fuse.value * 0 },
          { translateY: y },
          { rotate: `${rot}deg` },
          { scale: 1 - 0.04 * (3 - i) * stack.value * (1 - fuse.value) },
        ],
      };
    });
  const t0 = tileStyle(0);
  const t1 = tileStyle(1);
  const t2 = tileStyle(2);
  const t3 = tileStyle(3);
  const tiles = [t0, t1, t2, t3];

  // The fused card grows from the lead tile; the trimmer lives on it.
  const CARD_W = 330;
  const CARD_H = 232;
  const cardStyle = useAnimatedStyle(() => ({
    opacity: fuse.value,
    transform: [{ scale: 0.9 + 0.1 * fuse.value }],
  }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value }));
  // Trim handles + dimmed margins (fractions of the fused card width).
  const leftDimStyle = useAnimatedStyle(() => ({ width: `${trimL.value * 19}%` as unknown as number }));
  const rightDimStyle = useAnimatedStyle(() => ({ width: `${trimR.value * 19}%` as unknown as number }));
  const leftHandleStyle = useAnimatedStyle(() => ({ left: `${trimL.value * 19}%` as unknown as number }));
  const rightHandleStyle = useAnimatedStyle(() => ({ right: `${trimR.value * 19}%` as unknown as number }));
  const reelStyle = useAnimatedStyle(() => ({ opacity: reelOpacity.value, transform: [{ scale: reelScale.value }] }));

  // The stitch strip: three segments slide together and lock edge-to-edge.
  // The middle one is the clip we just trimmed, so the kept moment visibly
  // becomes part of the reel rather than the picture simply not changing.
  const SEG_W = 112;
  const SEG_H = 150;
  const segStyle = (i: number) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => ({
      opacity: i === 1 ? 1 : stitchP.value,
      transform: [{ translateX: (i - 1) * 96 * (1 - stitchP.value) }],
    }));
  const g0 = segStyle(0);
  const g1 = segStyle(1);
  const g2 = segStyle(2);
  const segs = [g0, g1, g2];

  useEffect(() => {
    // 0.0–1.6s: four LARGE shots sit along the bottom. "recorded videos…"
    rise.value = withDelay(1400, withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) }, (f) => {
      if (f) runOnJS(setBeat)('stack');
    }));
    // 2.5s: they slide over each other into a stack in the middle.
    stack.value = withDelay(2500, withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.cubic) }, (f) => {
      if (f) runOnJS(setBeat)('fuse');
    }));
    // 3.6s: vibrate, then FUSE — flash + heavy haptic, four → one.
    buzz.value = withDelay(3600, withRepeat(withTiming(1, { duration: 55 }), 12, true));
    fuse.value = withDelay(4300, withTiming(1, { duration: 650, easing: Easing.out(Easing.cubic) }, (f) => {
      if (f) {
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Heavy);
        runOnJS(setBeat)('trim');
      }
    }));
    flash.value = withDelay(4300, withSequence(withTiming(0.85, { duration: 120 }), withTiming(0, { duration: 320 })));
    // 5.2s: "AI trims…" — the trimmer handles close in to the seconds that matter.
    trimL.value = withDelay(5400, withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.cubic) }));
    trimR.value = withDelay(5400, withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.cubic) }, (f) => {
      if (f) {
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Medium);
        runOnJS(setBeat)('stitch');
      }
    }));
    // 6.9s: the three segments converge and lock — the stitch itself.
    stitchP.value = withDelay(6900, withTiming(1, { duration: 600, easing: Easing.out(Easing.cubic) }));
    // 7.2s: stitch → reel.
    reelOpacity.value = withDelay(7600, withTiming(1, { duration: 500 }));
    reelScale.value = withDelay(7600, withTiming(1, { duration: 700 }, (f) => {
      if (f) {
        runOnJS(setBeat)('reel');
        runOnJS(playReel)();
      }
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function playReel() {
    player?.play();
  }

  const NARRATION: Record<Beat, string> = {
    gather: 'Recorded videos are long and hard to edit.',
    stack: 'Recorded videos are long and hard to edit.',
    fuse: 'Recorded videos are long and hard to edit.',
    trim: 'AI trims everything into the few seconds that matter.',
    stitch: 'Then stitches them into one reel.',
    reel: 'Reel ready to share.',
  };

  const showTiles = beat === 'gather' || beat === 'stack' || beat === 'fuse';
  const showCard = beat === 'fuse' || beat === 'trim';
  const showStrip = beat === 'stitch';

  return (
    <View style={[styles.fill, { backgroundColor: '#0A0A0F' }]}>
      {/* Reel always mounted (opacity-driven), so hook count never changes. */}
      {player && VideoView && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, reelStyle]}>
          <VideoView player={player} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />
        </Animated.View>
      )}

      {/* The four tiles: bottom row → risen stack → fade into the fused card. */}
      {showTiles && (
        <View style={[styles.fill, styles.center, styles.contentLift]} pointerEvents="none">
          <View style={{ width: 300, height: 320, alignItems: 'center', justifyContent: 'center' }}>
            {POSTERS.map((src, i) => (
              <Animated.View key={i} style={[styles.storyBigTile, { width: TILE_W, height: TILE_H }, tiles[i]]}>
                <Image source={src} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </Animated.View>
            ))}
          </View>
        </View>
      )}

      {/* The fused card + trimmer. A big centred clip; handles + dimmed
          margins appear only while trimming ('trim'); on 'stitch' the trim is
          done so the card is a clean kept clip, matching the caption. */}
      {showCard && (
        <View style={[styles.fill, styles.center, styles.contentLift]} pointerEvents="none">
          <Animated.View style={[styles.fusedCard, { width: CARD_W, height: CARD_H }, cardStyle]}>
            <Image source={TRIM_FRAME} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            {beat === 'trim' && (
              <>
                <Animated.View style={[styles.trimDim, { left: 0 }, leftDimStyle]} />
                <Animated.View style={[styles.trimDim, { right: 0 }, rightDimStyle]} />
                <Animated.View style={[styles.trimHandle, leftHandleStyle]} />
                <Animated.View style={[styles.trimHandle, rightHandleStyle]} />
              </>
            )}
          </Animated.View>
          {beat === 'trim' && (
            <Animated.View entering={FadeIn.duration(200)} style={[styles.secondsPill, { top: '50%', marginTop: CARD_H / 2 + 18 }]}>
              <Text style={styles.secondsPillText}>the 3s that matter</Text>
            </Animated.View>
          )}
        </View>
      )}

      {/* The stitch: three segments converge and lock edge-to-edge. Distinct
          from the trim beat by construction — if this rendered the same card
          again, two consecutive beats would look frozen. */}
      {showStrip && (
        <View style={[styles.fill, styles.center, styles.contentLift]} pointerEvents="none">
          <View style={{ flexDirection: 'row' }}>
            {[POSTERS[0], TRIM_FRAME, POSTERS[2]].map((src, i) => (
              <Animated.View key={i} style={[styles.stripSeg, { width: SEG_W, height: SEG_H }, segs[i]]}>
                <Image source={src} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </Animated.View>
            ))}
          </View>
        </View>
      )}

      {/* White fuse flash */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: '#fff' }, flashStyle]} />

      {beat !== 'reel' ? (
        <View style={styles.narrationWrap} pointerEvents="none">
          <Animated.Text key={NARRATION[beat]} entering={FadeIn.duration(300)} style={styles.narration}>
            {NARRATION[beat]}
          </Animated.Text>
        </View>
      ) : (
        // On the reel the text sits on bright footage, so it gets its own dark
        // band high on the screen, clear of the "Now make YOURS" button.
        <View style={styles.reelNarrationBand} pointerEvents="none">
          <Text style={styles.reelNarrationText}>Reel ready to share</Text>
        </View>
      )}

      {beat === 'reel' && (
        <Animated.View entering={FadeIn.duration(400)} style={styles.storyCta}>
          <Pressable onPress={onNext} style={styles.cta}>
            <Text style={styles.ctaText}>Share it</Text>
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
  beatWrap: { position: 'absolute', bottom: 130, left: 24, right: 24, alignItems: 'center' },
  beatText: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8 },
  brandWrap: { position: 'absolute', top: 70, left: 0, right: 0, alignItems: 'center' },
  wordmark: { width: 176, height: 111 },  // 967x609 artwork aspect
  titleScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 380 },
  topStack: { position: 'absolute', top: 70, left: 24, right: 24, alignItems: 'center', gap: 14 },
  bigWord: {
    color: '#f0f4ee',
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'HelveticaNeue-CondensedBlack' : undefined,
    textAlign: 'center',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 12,
  },
  bigWordGreen: { color: '#A4C71C' },
  ball: { position: 'absolute', top: 0, left: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', shadowColor: '#fff', shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  storyBigTile: { position: 'absolute', borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  fusedCard: { position: 'absolute', borderRadius: 14, overflow: 'hidden', backgroundColor: '#000', borderWidth: 2, borderColor: '#fff' },
  trimDim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.62)' },
  trimHandle: { position: 'absolute', top: 0, bottom: 0, width: 8, backgroundColor: '#FFD54F', borderRadius: 3 },
  secondsPill: { position: 'absolute', alignSelf: 'center', backgroundColor: '#FFD54F', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  secondsPillText: { color: '#0A0A0F', fontSize: 15, fontWeight: '900' },
  reelNarrationBand: { position: 'absolute', top: 90, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 14, paddingHorizontal: 18, paddingVertical: 10 },
  reelNarrationText: { color: '#fff', fontSize: 18, fontWeight: '800', textAlign: 'center' },
  // Content sat dead-centre of the full screen, which left the top ~37% empty
  // and pushed everything into the lower two-thirds. Lifting it is one padding.
  contentLift: { paddingBottom: 200 },
  stripSeg: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#000', borderWidth: 2, borderColor: 'rgba(255,255,255,0.75)' },
  // The caption is scrimmed, not just shadowed: while the four tiles rise from
  // the bottom edge they pass straight through this band, and white-on-grass
  // with only a text shadow left "to edit." close to unreadable. Invisible
  // over the black beats, load-bearing over the tiles — same fix as the reel.
  narrationWrap: { position: 'absolute', bottom: 140, left: 24, right: 24, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 },
  narration: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8 },
  storyCta: { position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' },
  progressTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#4CAF50' },
  slotRow: { position: 'absolute', bottom: 90, flexDirection: 'row', gap: 14 },
  appSlot: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.12)' },
  reelCard: { width: '100%', height: '100%', overflow: 'hidden' },
  exampleBadge: { borderWidth: 1.5, borderColor: '#FFD54F', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  exampleFloat: { position: 'absolute', top: 64, alignSelf: 'center', backgroundColor: 'rgba(10,10,15,0.75)' },
  exampleBadgeText: { color: '#FFD54F', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  // Record-screen chrome, lifted from app/(tabs)/record.tsx so the lesson is
  // the production screen to the pixel. Keep these in step with that file.
  recPill: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16 },
  recPillArmed: { backgroundColor: '#4CAF50' },
  recPillText: { fontSize: 11, fontWeight: '600' },
  coachBand: { position: 'absolute', left: 24, right: 24, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 },
  coachText: { color: '#fff', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  recBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingTop: 16 },
  recCameraRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, marginBottom: 18 },
  recZoomToggle: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 18, padding: 3, gap: 2 },
  recZoomPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 15 },
  recZoomPillActive: { backgroundColor: 'rgba(255,255,255,0.18)' },
  recZoomText: { color: theme.colors.textTertiary, fontSize: 13, fontWeight: '700' },
  recFlip: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  recActionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24 },
  recActionBtn: { alignItems: 'center', justifyContent: 'center', gap: 4, width: 70 },
  recActionText: { color: '#FF6B6B', fontSize: 11, fontWeight: '600' },
  recHoleNav: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recHoleBtn: { alignItems: 'center', justifyContent: 'center', gap: 4, width: 56 },
  // Instagram-story frame for the demo reel: chrome above/below, never over the video.
  storyCard: { borderRadius: 18, overflow: 'hidden', backgroundColor: '#000', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  storyHead: { paddingHorizontal: 10, paddingTop: 8, backgroundColor: '#000' },
  storyProgress: { height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
  storyProgressFill: { height: 2, backgroundColor: '#fff' },
  storyHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  storyAvatar: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#A4C71C' },
  storyName: { color: '#fff', fontSize: 13, fontWeight: '700' },
  storyTime: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  storyFoot: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, backgroundColor: '#000' },
  storyReply: { flex: 1, height: 34, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', justifyContent: 'center', paddingHorizontal: 14 },
  storyReplyText: { color: 'rgba(255,255,255,0.7)', fontSize: 13 },
  cta: { backgroundColor: '#4CAF50', borderRadius: 16, paddingHorizontal: 30, paddingVertical: 16, marginTop: 12 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});

