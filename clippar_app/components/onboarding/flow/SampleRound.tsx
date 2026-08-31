/**
 * The sample round — press through Henry's par 5, watch it become a reel.
 *
 * Plan §13.5, built on the creative pass's filmstrip stitch (the one idea it
 * said to fight for): each press plays a RAW capture; when it ends, the
 * clip's poster flies down into a filmstrip slot and is visibly shaved to
 * just the swing; after the fifth, the gaps slam shut and the fused strip
 * becomes a playing reel. Press → trim → stitch → watch, enacted in ~15s on
 * a user who owns no golf footage.
 *
 * Honest about its trick, per the plan: the "shave" is a slot-width
 * animation over the strike poster; the played reel is ONE offline ffmpeg
 * concat of the real trims (strike−2.5s..strike+1.5s — the app's own trim
 * shape) bundled as an asset. The real pipeline is exercised by the
 * tutorial and by their own clips; this beat exists to make the loop FELT.
 *
 * Every video stall degrades to posters + timers (the same wedge-guard
 * discipline as CinematicOnboarding); haptics fire on discrete moments only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, useSharedValue, useAnimatedStyle, withTiming, withSpring, withDelay, Easing, runOnJS } from 'react-native-reanimated';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

const SHOTS = [
  { clip: require('@/assets/onboarding/sample1.mp4'), poster: require('@/assets/onboarding/sample1_poster.jpg'), label: 'Drive' },
  { clip: require('@/assets/onboarding/sample2.mp4'), poster: require('@/assets/onboarding/sample2_poster.jpg'), label: 'Punch-out' },
  { clip: require('@/assets/onboarding/sample3.mp4'), poster: require('@/assets/onboarding/sample3_poster.jpg'), label: 'Approach' },
  { clip: require('@/assets/onboarding/sample4.mp4'), poster: require('@/assets/onboarding/sample4_poster.jpg'), label: 'Chip' },
  { clip: require('@/assets/onboarding/sample5.mp4'), poster: require('@/assets/onboarding/sample5_poster.jpg'), label: 'Putt' },
] as const;
const REEL = require('@/assets/onboarding/sample_reel.mp4');

// Filmstrip geometry (pts). Slot shave: RAW_W -> TRIM_W with overflow hidden
// is the visible "cut to just the swing".
const RAW_W = 96;
const TRIM_W = 56;
const SLOT_H = 84;
const GAP = 8;

type Phase =
  | { name: 'ready'; idx: number }     // poster up, clicker waiting
  | { name: 'playing'; idx: number }   // raw clip running
  | { name: 'landing'; idx: number }   // poster flying to its slot
  | { name: 'fusing' }                 // gaps slam shut
  | { name: 'reel' }                   // the stitched reel plays
  | { name: 'done' };

export function SampleRound({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ name: 'ready', idx: 0 });
  const [landed, setLanded] = useState(0); // slots filled so far
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const { useVideoPlayer, VideoView } = ExpoVideo ?? { useVideoPlayer: null, VideoView: null };
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const player = ExpoVideo ? ExpoVideo.useVideoPlayer(null, (p) => { p.loop = false; }) : null;

  // ---- flying poster (one animated image reused per landing) ----
  const flyX = useSharedValue(0);
  const flyY = useSharedValue(0);
  const flyScale = useSharedValue(1);
  const flyOpacity = useSharedValue(0);
  const shave = useSharedValue(RAW_W); // landing slot's width during shave
  const fuse = useSharedValue(GAP);    // gap between slots at fuse time
  const stripScale = useSharedValue(1);

  const flyStyle = useAnimatedStyle(() => ({
    opacity: flyOpacity.value,
    transform: [{ translateX: flyX.value }, { translateY: flyY.value }, { scale: flyScale.value }],
  }));
  const newestSlotStyle = useAnimatedStyle(() => ({ width: shave.value }));
  const stripStyle = useAnimatedStyle(() => ({
    gap: fuse.value,
    transform: [{ scale: stripScale.value }],
  }));

  const advanceAfterLanding = useCallback((idx: number) => {
    setLanded(idx + 1);
    if (idx + 1 >= SHOTS.length) {
      // All five in — slam the gaps shut, then become the reel.
      setPhase({ name: 'fusing' });
      fuse.value = withDelay(250, withTiming(0, { duration: 300, easing: Easing.in(Easing.cubic) }));
      stripScale.value = withDelay(650, withTiming(1.15, { duration: 350 }, (finished) => {
        if (finished) runOnJS(startReel)();
      }));
    } else {
      setPhase({ name: 'ready', idx: idx + 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startReel() {
    setPhase({ name: 'reel' });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (player) {
      player.replaceAsync(REEL).then(() => player.play()).catch(() => {});
    }
  }

  const land = useCallback(
    (idx: number) => {
      setPhase({ name: 'landing', idx });
      // Full-bleed → slot rect. Slots row is bottom-centred; compute the
      // target X of slot idx from the strip's centred layout.
      const stripW = SHOTS.length * TRIM_W + (SHOTS.length - 1) * GAP;
      const slotCX = -stripW / 2 + idx * (TRIM_W + GAP) + TRIM_W / 2;
      flyOpacity.value = 1;
      flyX.value = 0;
      flyY.value = 0;
      flyScale.value = 1;
      flyX.value = withTiming(slotCX, { duration: 450, easing: Easing.in(Easing.cubic) });
      flyY.value = withTiming(0, { duration: 450, easing: Easing.in(Easing.cubic) });
      flyScale.value = withTiming(0.001, { duration: 450, easing: Easing.in(Easing.cubic) }, (f) => {
        if (!f) return;
        flyOpacity.value = 0;
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Light);
        runOnJS(advanceAfterLanding)(idx);
      });
      // The shave: the just-landed slot starts raw-width and cuts down.
      shave.value = RAW_W;
      shave.value = withDelay(420, withTiming(TRIM_W, { duration: 350, easing: Easing.out(Easing.cubic) }));
    },
    [advanceAfterLanding, flyOpacity, flyScale, flyX, flyY, shave]
  );

  const onClicker = useCallback(() => {
    const p = phaseRef.current;
    if (p.name !== 'ready') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase({ name: 'playing', idx: p.idx });
    if (player) {
      player.replaceAsync(SHOTS[p.idx].clip).then(() => player.play()).catch(() => land(p.idx));
    } else {
      setTimeout(() => land(p.idx), 1500);
    }
  }, [player, land]);

  // Clip end → land it. Wedge guard: no raw clip may run past 9s.
  useEffect(() => {
    if (phase.name !== 'playing' || !player) return;
    const idx = phase.idx;
    const sub = player.addListener('playToEnd', () => land(idx));
    const guard = setTimeout(() => land(idx), 9000);
    return () => {
      sub.remove();
      clearTimeout(guard);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name === 'playing' ? phase.idx : -1, player]);

  // Reel end → done card. Guard at 20s (reel is 16.7s).
  useEffect(() => {
    if (phase.name !== 'reel' || !player) return;
    const sub = player.addListener('playToEnd', () => setPhase({ name: 'done' }));
    const guard = setTimeout(() => setPhase({ name: 'done' }), 20_000);
    return () => {
      sub.remove();
      clearTimeout(guard);
    };
  }, [phase.name, player]);

  const showingVideo = (phase.name === 'playing' || phase.name === 'reel') && VideoView && player;
  const currentIdx = phase.name === 'ready' || phase.name === 'playing' || phase.name === 'landing' ? phase.idx : SHOTS.length - 1;

  return (
    <View style={styles.fill}>
      {/* Stage: poster when waiting, video when rolling */}
      {showingVideo ? (
        <VideoView player={player!} style={StyleSheet.absoluteFillObject} contentFit="cover" nativeControls={false} />
      ) : (
        <Image source={SHOTS[currentIdx].poster} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
      )}
      {phase.name === 'fusing' && <View style={styles.dim} />}

      {/* Shot label + count */}
      {phase.name !== 'reel' && phase.name !== 'done' && (
        <View style={styles.topChip}>
          <Text style={styles.topChipText}>
            {SHOTS[currentIdx].label} · shot {Math.min(currentIdx + 1, 5)} of 5
          </Text>
        </View>
      )}

      {/* The flying poster (fades in only during landing) */}
      {phase.name === 'landing' && (
        <Animated.View style={[styles.flyWrap, flyStyle]} pointerEvents="none">
          <Image source={SHOTS[phase.idx].poster} style={styles.flyImg} resizeMode="cover" />
        </Animated.View>
      )}

      {/* Filmstrip */}
      {phase.name !== 'reel' && phase.name !== 'done' && (
        <Animated.View style={[styles.strip, stripStyle]}>
          {SHOTS.map((s, i) => {
            const filled = i < landed;
            const isNewest = i === landed - 1;
            const Slot = isNewest ? Animated.View : View;
            return (
              <Slot key={s.label} style={[styles.slot, isNewest ? newestSlotStyle : { width: filled ? TRIM_W : TRIM_W }, !filled && styles.slotEmpty]}>
                {filled && <Image source={s.poster} style={styles.slotImg} resizeMode="cover" />}
              </Slot>
            );
          })}
        </Animated.View>
      )}

      {/* Clicker */}
      {phase.name === 'ready' && (
        <View style={styles.clickerDock}>
          <Text style={styles.prompt}>
            {phase.idx === 0 ? "Henry's on the tee. Press the clicker." : 'Press for the next shot.'}
          </Text>
          <Pressable onPress={onClicker} style={styles.clicker}>
            <View style={styles.clickerInner} />
          </Pressable>
        </View>
      )}

      {phase.name === 'reel' && (
        <Animated.View entering={FadeIn.duration(300)} style={styles.reelChip}>
          <Text style={styles.topChipText}>Your five presses, stitched. No editing.</Text>
        </Animated.View>
      )}

      {phase.name === 'done' && (
        <Animated.View entering={FadeIn.duration(300)} style={[styles.fill, styles.center, { backgroundColor: 'rgba(10,10,15,0.85)', padding: 32 }]}>
          <View style={{ alignItems: 'center', gap: 14 }}>
            <Text style={styles.h1}>That's a Clippar reel</Text>
            <Text style={styles.sub}>Five presses on the course. Zero editing. Yours will look like this.</Text>
            <Pressable onPress={onDone} style={styles.cta}>
              <Text style={styles.ctaText}>Keep going</Text>
            </Pressable>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  topChip: { position: 'absolute', top: 60, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  topChipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  flyWrap: { position: 'absolute', bottom: 120, alignSelf: 'center', width: RAW_W, height: SLOT_H, borderRadius: 8, overflow: 'hidden' },
  flyImg: { width: '100%', height: '100%' },
  strip: { position: 'absolute', bottom: 24, alignSelf: 'center', flexDirection: 'row', alignItems: 'center' },
  slot: { height: SLOT_H, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
  slotEmpty: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', borderStyle: 'dashed' },
  slotImg: { width: '100%', height: '100%' },
  clickerDock: { position: 'absolute', bottom: 130, left: 0, right: 0, alignItems: 'center', gap: 12 },
  prompt: { color: '#fff', fontSize: 15, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 6 },
  clicker: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#1B5E20', borderWidth: 4, borderColor: '#4CAF50', alignItems: 'center', justifyContent: 'center', shadowColor: '#4CAF50', shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  clickerInner: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#4CAF50' },
  reelChip: { position: 'absolute', bottom: 40, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  h1: { color: '#fff', fontSize: 24, fontWeight: '800', textAlign: 'center' },
  sub: { color: 'rgba(255,255,255,0.75)', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  cta: { backgroundColor: '#4CAF50', borderRadius: 16, paddingHorizontal: 28, paddingVertical: 14, marginTop: 10 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
