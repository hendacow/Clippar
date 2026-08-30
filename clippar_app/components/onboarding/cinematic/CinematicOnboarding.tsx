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
import { View, Text, Pressable, StyleSheet, Platform, Animated as RNAnimated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { CLICK_WINDOW_MS } from '@/hooks/useShutter';
import { logFunnel } from '@/lib/onboardingFunnel';
import { getSetting, setSetting } from '@/lib/storage';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

// Bundled real footage — see assets/onboarding/. montage is 12s cut from a
// real exported reel; shots 1-3 are detector-trimmed swings (~5s each).
const VIDEOS = {
  montage: require('@/assets/onboarding/montage.mp4'),
  shot1: require('@/assets/onboarding/shot1.mp4'),
  shot2: require('@/assets/onboarding/shot2.mp4'),
  shot3: require('@/assets/onboarding/shot3.mp4'),
} as const;

const SCENES = [
  'MONTAGE',
  'CLICKER_INTRO',
  'RECORD_SHOT',
  'NEXT_HOLE',
  'PENALTY',
  'PREVIEW',
  'EXPORT',
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
  PREVIEW: 15_000,
  EXPORT: 15_000,
};

export function CinematicOnboarding({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const insets = useSafeAreaInsets();
  const [scene, setScene] = useState<Scene>('MONTAGE');
  const [showSkip, setShowSkip] = useState(false);
  const sceneStartedAt = useRef(Date.now());
  const sceneRef = useRef<Scene>('MONTAGE');
  sceneRef.current = scene;

  // ---- scene transitions ----------------------------------------------
  const goTo = useCallback((next: Scene) => {
    logFunnel('v2', sceneRef.current, 'complete', Date.now() - sceneStartedAt.current);
    sceneStartedAt.current = Date.now();
    setScene(next);
    void setSetting(SCENE_KEY, next).catch(() => {});
    logFunnel('v2', next, 'enter', 0);
  }, []);

  const advance = useCallback(() => {
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
      {scene === 'CLICKER_INTRO' && <ClickerIntroScene onNext={advance} />}
      {scene === 'RECORD_SHOT' && <RecordShotScene onNext={advance} />}
      {scene === 'NEXT_HOLE' && <MultiTapScene key="nh" taps={2} video={VIDEOS.shot2}
        title="Double-tap = next hole" sub="Two quick taps on the clicker moves your round along." confirm="Hole 2 →" onNext={advance} />}
      {scene === 'PENALTY' && <MultiTapScene key="pen" taps={3} video={VIDEOS.shot3}
        title="Found trouble? Triple-tap" sub="Three taps adds a penalty stroke — honesty, automated." confirm="+1 penalty" onNext={advance} />}
      {scene === 'PREVIEW' && <PreviewScene onNext={advance} />}
      {scene === 'EXPORT' && <ExportScene onNext={advance} />}

      {showSkip && (
        <Pressable onPress={skip} hitSlop={12} style={[styles.skip, { top: insets.top + 10 }]}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---- shared bits --------------------------------------------------------

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

function MontageScene({ onNext }: { onNext: () => void }) {
  // Value lines ride the montage's back half — no separate explainer scene.
  const [beat, setBeat] = useState(0);
  const pRef = useRef<import('expo-video').VideoPlayer | null>(null);
  useEffect(() => {
    const beats = [setTimeout(() => setBeat(1), 5000), setTimeout(() => setBeat(2), 7500), setTimeout(() => setBeat(3), 10_000)];
    return () => beats.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      const p = pRef.current;
      if (p && p.duration > 0 && p.currentTime >= p.duration - 0.15) onNext();
    }, 250);
    return () => clearInterval(iv);
  }, [onNext]);
  const lines = ['', 'Films every shot. Keeps the good ones.', 'Cuts your round into a reel.', 'No editing. Ever.'];
  return (
    <View style={styles.fill}>
      <SceneVideo source={VIDEOS.montage} playerRef={(p) => (pRef.current = p)} />
      {beat > 0 && (
        <Animated.View key={beat} entering={FadeIn.duration(350)} exiting={FadeOut.duration(200)} style={styles.beatWrap}>
          <Text style={styles.beatText}>{lines[beat]}</Text>
        </Animated.View>
      )}
      <View style={styles.brandWrap}>
        <Animated.Text entering={FadeIn.duration(600)} style={styles.brand}>Clippar</Animated.Text>
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
      <View style={styles.hudTop}>
        <View style={styles.hudChip}><Text style={styles.hudChipText}>Hole 1 · Par 4</Text></View>
        {phase !== 'address' && (
          <View style={[styles.hudChip, { backgroundColor: 'rgba(229,57,53,0.9)' }]}>
            <Text style={styles.hudChipText}>● REC</Text>
          </View>
        )}
      </View>
      {phase === 'slowmo' && (
        <Animated.View entering={FadeIn.duration(250)} style={styles.beatWrap}>
          <Text style={styles.beatText}>Slow-mo on the strike. Automatic.</Text>
        </Animated.View>
      )}
      <View style={styles.clickerDock}>
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
        ) : (
          <Animated.View entering={FadeIn.duration(250)} style={styles.confirmCard}>
            <Text style={styles.confirmText}>{confirm}</Text>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

function PreviewScene({ onNext }: { onNext: () => void }) {
  // The three shots just "recorded", 2s each; tap hurries it along.
  const clips = [VIDEOS.shot1, VIDEOS.shot2, VIDEOS.shot3];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => (i < clips.length - 1 ? setI(i + 1) : onNext()), 2000);
    return () => clearTimeout(t);
  }, [i, onNext, clips.length]);
  return (
    <Pressable style={styles.fill} onPress={() => (i < clips.length - 1 ? setI(i + 1) : onNext())}>
      <SceneVideo key={i} source={clips[i]} muted />
      <View style={styles.beatWrap}>
        <Text style={styles.beatText}>Your round, cut to the good bits · {i + 1}/3</Text>
      </View>
    </Pressable>
  );
}

function ExportScene({ onNext }: { onNext: () => void }) {
  // PLACEHOLDER until Henry's real screen-recording of posting to his own
  // story lands (see plan §7 — real footage of a real post replaces any
  // recreated social UI). Until then: a progress beat + an EXAMPLE card.
  const [done, setDone] = useState(false);
  const progress = useRef(new RNAnimated.Value(0)).current;
  useEffect(() => {
    RNAnimated.timing(progress, { toValue: 1, duration: 2200, useNativeDriver: false }).start(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    });
  }, [progress]);
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: '#0A0A0F', padding: 32 }]}>
      {!done ? (
        <View style={{ width: '80%', gap: 14, alignItems: 'center' }}>
          <Text style={styles.h1}>Exporting your reel…</Text>
          <View style={styles.progressTrack}>
            <RNAnimated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
          </View>
        </View>
      ) : (
        <Animated.View entering={FadeIn.duration(300)} style={{ alignItems: 'center', gap: 16 }}>
          <View style={styles.exampleBadge}><Text style={styles.exampleBadgeText}>EXAMPLE</Text></View>
          <Text style={styles.h1}>Ready to share anywhere</Text>
          <Text style={styles.sub}>One tap sends your real reels to any app on your phone.</Text>
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
  beatWrap: { position: 'absolute', bottom: 130, left: 24, right: 24, alignItems: 'center' },
  beatText: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8 },
  brandWrap: { position: 'absolute', top: 70, left: 0, right: 0, alignItems: 'center' },
  brand: { color: '#fff', fontSize: 34, fontWeight: '900', letterSpacing: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 10 },
  clicker: { width: 84, height: 84, borderRadius: 42, backgroundColor: '#1B5E20', borderWidth: 4, borderColor: '#4CAF50', alignItems: 'center', justifyContent: 'center', shadowColor: '#4CAF50', shadowOpacity: 0.6, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  clickerInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#4CAF50' },
  clickerLabel: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 6 },
  clickerDock: { position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' },
  hudTop: { position: 'absolute', top: 60, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' },
  hudChip: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  hudChipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  confirmCard: { backgroundColor: 'rgba(76,175,80,0.95)', borderRadius: 18, paddingHorizontal: 28, paddingVertical: 18 },
  confirmText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  progressTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#4CAF50' },
  exampleBadge: { borderWidth: 1.5, borderColor: '#FFD54F', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  exampleBadgeText: { color: '#FFD54F', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  cta: { backgroundColor: '#4CAF50', borderRadius: 16, paddingHorizontal: 30, paddingVertical: 16, marginTop: 12 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
