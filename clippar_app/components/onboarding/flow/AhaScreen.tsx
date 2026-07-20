/**
 * Screen 8 — the REAL aha: pick a swing from the camera roll and watch it
 * become a reel (trimmed clip + vibe music + overlay chrome). This is the
 * compliant 3.1.2(c) value demonstration that makes the paywall honest.
 *
 * Fallback ladder (never dead-ends, never claims a sample is "yours"):
 *   1. PHPicker clip → detectAndTrim finds the swing → play trimmed clip.
 *   2. Detection found:false but native module present → trim the middle ~6s
 *      via trimVideo (or play as-is when short) → still THEIR clip.
 *   3. Native module absent (Expo Go / old binary), detection threw, or the
 *      user has no golf clips → "Watch a sample" (MockReel + music) with
 *      honest sample copy.
 *   4. Picker cancelled / iCloud download failed → back to the chooser,
 *      which always offers the sample path forward.
 *
 * v1 deliberately does NOT call composeReel — a trimmed clip + music +
 * overlay UI is the aha; full composition happens in the real app flow.
 *
 * PHPicker (expo-image-picker launchImageLibraryAsync) needs NO permission
 * prompt on iOS — zero OS prompts during onboarding.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Dimensions, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  useReducedMotion,
} from 'react-native-reanimated';
import { Check, Clapperboard, Music } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  detectAndTrim,
  trimVideo,
  isShotDetectorAvailable,
} from '@/modules/shot-detector';
import { FlowButton } from '../sales/primitives';
import { FlowScreen, Rise, H1, Sub } from './FlowKit';
import { MockReel } from './MockReel';
import { computeFallbackTrimWindow } from './ahaTrim';
import { vibeOptions, vibeLabel } from '@/constants/onboardingV2';
import { intentEcho, shotEcho, type ReelVibe } from '@/lib/onboardingProfile';
import type { FlowScreenProps, AhaOutcome } from './Screens';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const MIN_BUILD_MS = 2400; // labor illusion floor — never flash the loader

type Phase =
  | { name: 'choose' }
  | { name: 'building' }
  | { name: 'playback'; outcome: AhaOutcome; videoUri: string | null };

export function AhaScreen({ answers, setAnswers, setAhaOutcome, onNext }: FlowScreenProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'choose' });
  const busyRef = useRef(false);

  const pickClip = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      let result: ImagePicker.ImagePickerResult | null = null;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'],
          allowsMultipleSelection: false,
          quality: 1,
        });
      } catch (err) {
        // iCloud-only asset that failed to stream down, or picker hiccup
        // (see app/round/import.tsx for the field history). Not fatal —
        // the chooser stays up with the sample path available.
        console.warn('[onboarding-aha] picker failed:', err);
        result = null;
      }
      const asset = result && !result.canceled ? result.assets?.[0] : null;
      if (!asset?.uri) return; // cancelled → stay on chooser (way forward: sample)

      setPhase({ name: 'building' });
      const startedAt = Date.now();

      let videoUri: string | null = null;
      try {
        const detection = await detectAndTrim(asset.uri, 3000, 2000, []);
        if (detection.found && detection.trimmedUri) {
          videoUri = detection.trimmedUri;
        } else if (isShotDetectorAvailable()) {
          // Detection genuinely found nothing — show THEIR clip anyway,
          // trimmed to the middle ~6s so it still feels cut.
          const win = computeFallbackTrimWindow(asset.duration ?? null);
          if (win) {
            const trimmed = await trimVideo(asset.uri, win.startMs, win.endMs);
            videoUri = trimmed.trimmedUri ?? asset.uri;
          } else {
            videoUri = asset.uri;
          }
        }
        // Native module absent → videoUri stays null → sample fallback.
      } catch (err) {
        console.warn('[onboarding-aha] detection failed:', err);
        videoUri = null;
      }

      // Hold the labor-illusion beat even when processing was instant.
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_BUILD_MS) {
        await new Promise((r) => setTimeout(r, MIN_BUILD_MS - elapsed));
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (videoUri) {
        setPhase({ name: 'playback', outcome: 'real', videoUri });
      } else {
        setPhase({ name: 'playback', outcome: 'sample', videoUri: null });
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const watchSample = useCallback(() => {
    Haptics.selectionAsync();
    setPhase({ name: 'playback', outcome: 'sample', videoUri: null });
  }, []);

  if (phase.name === 'building') {
    return <BuildingReel answers={answers} />;
  }

  if (phase.name === 'playback') {
    return (
      <ReelPlayback
        outcome={phase.outcome}
        videoUri={phase.videoUri}
        vibe={answers.vibe}
        courseName={answers.homeCourseName}
        onKeepGoing={() => {
          setAhaOutcome(phase.outcome);
          onNext();
        }}
        onPickAnother={() => setPhase({ name: 'choose' })}
      />
    );
  }

  return (
    <FlowScreen
      title="Pick a swing from your camera roll — we'll turn it into a reel."
      sub="Any clip with a swing in it. We'll find the good part."
      footer={
        <>
          <FlowButton label="Pick a clip" onPress={pickClip} />
          <Pressable onPress={watchSample} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.link}>No golf clips yet? Watch a sample</Text>
          </Pressable>
        </>
      }
    >
      <Rise delay={220} style={{ marginTop: 26 }}>
        <Text style={styles.vibeHeading}>Reel vibe</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          {vibeOptions.map((v) => (
            <VibeCard
              key={v.id}
              label={v.label}
              tagline={v.tagline}
              selected={answers.vibe === v.id}
              onPress={() => {
                Haptics.selectionAsync();
                setAnswers({ vibe: v.id });
              }}
            />
          ))}
        </View>
      </Rise>
    </FlowScreen>
  );
}

/* ── Vibe card ────────────────────────────────────────────────────────── */

function VibeCard({
  label,
  tagline,
  selected,
  onPress,
}: {
  label: string;
  tagline: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1 }} accessibilityRole="button">
      <View
        style={[
          styles.vibeCard,
          {
            borderColor: selected ? theme.colors.primary : theme.colors.surfaceBorder,
            backgroundColor: selected ? `${theme.colors.primary}1A` : theme.colors.surfaceElevated,
          },
        ]}
      >
        <Music size={16} color={selected ? theme.colors.primary : theme.colors.textTertiary} />
        <Text style={styles.vibeLabel}>{label}</Text>
        <Text style={styles.vibeTagline} numberOfLines={2}>
          {tagline}
        </Text>
        {selected ? (
          <View style={styles.vibeCheck}>
            <Check size={11} color="#fff" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/* ── "Building your reel" (labor illusion, quotes their answers) ──────── */

function BuildingReel({ answers }: { answers: FlowScreenProps['answers'] }) {
  const reduceMotion = useReducedMotion();
  const spin = useSharedValue(0);
  const [done, setDone] = useState(-1);

  const course = answers.homeCourseName ?? 'your course';
  const shots = answers.memorableShot ? shotEcho[answers.memorableShot] : 'the good part';
  const intent = answers.intent ? intentEcho[answers.intent] : 'reliving your best shots';
  const lines = [
    'Finding the swing…',
    `Cutting for ${vibeLabel[answers.vibe]} pace`,
    `Tuning for ${course} — ${intent}`,
    `Keeping an eye out for ${shots}`,
  ];

  useEffect(() => {
    if (!reduceMotion) {
      spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1);
    }
    const timers = lines.map((_, i) =>
      setTimeout(() => {
        setDone(i);
        Haptics.selectionAsync();
      }, 420 + i * 520)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ring = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  return (
    <View style={styles.buildWrap}>
      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[ring, styles.buildRing]} />
        <View style={{ position: 'absolute' }}>
          <Clapperboard size={22} color={theme.colors.primary} />
        </View>
      </View>
      <H1 center>Building your reel…</H1>
      <View style={{ gap: 13, alignSelf: 'stretch', paddingHorizontal: 8 }}>
        {lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={[
                styles.checkDot,
                { backgroundColor: done >= i ? theme.colors.primary : theme.colors.surfaceElevated },
              ]}
            >
              {done >= i ? <Check size={13} color="#fff" /> : null}
            </View>
            <Text
              style={{
                color: done >= i ? theme.colors.textPrimary : theme.colors.textTertiary,
                fontSize: 14,
                fontWeight: '600',
                flex: 1,
              }}
              numberOfLines={1}
            >
              {l}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ── Playback: their clip (or the honest sample) + vibe music ─────────── */

function ReelPlayback({
  outcome,
  videoUri,
  vibe,
  courseName,
  onKeepGoing,
  onPickAnother,
}: {
  outcome: AhaOutcome;
  videoUri: string | null;
  vibe: ReelVibe;
  courseName: string | null;
  onKeepGoing: () => void;
  onPickAnother: () => void;
}) {
  useVibeMusic(vibe);
  const reelW = SCREEN_W - 48;
  const reelH = Math.min(SCREEN_H * 0.5, reelW * 1.35);
  const real = outcome === 'real' && !!videoUri;

  return (
    <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 8 }}>
      <Animated.View entering={FadeIn.duration(350)} style={{ alignItems: 'center' }}>
        {real ? (
          <ClipCard uri={videoUri!} width={reelW} height={reelH} vibe={vibe} courseName={courseName} />
        ) : (
          <MockReel width={reelW} height={reelH} courseName={courseName} />
        )}
      </Animated.View>
      <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 8 }}>
        <Rise delay={200}>
          {real ? (
            <Sub>
              Your swing, cut to {vibeLabel[vibe]}.{courseName ? ` ${courseName} on the end-card.` : ''}
            </Sub>
          ) : (
            <Sub>
              Here's a sample reel — not yours, yet. Yours will star your own swings, cut to{' '}
              {vibeLabel[vibe]}.
            </Sub>
          )}
        </Rise>
        <Rise delay={320} style={{ gap: 12, marginTop: 16 }}>
          <FlowButton label="Keep going" onPress={onKeepGoing} />
          <Pressable onPress={onPickAnother} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.link}>{real ? 'Try a different clip' : 'Got a clip after all? Pick one'}</Text>
          </Pressable>
        </Rise>
      </View>
    </View>
  );
}

function ClipCard({
  uri,
  width,
  height,
  vibe,
  courseName,
}: {
  uri: string;
  width: number;
  height: number;
  vibe: ReelVibe;
  courseName: string | null;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true; // the vibe track carries the audio
    p.play();
  });
  return (
    <View style={[styles.clipFrame, { width, height }]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
      />
      {/* reel chrome */}
      <View style={styles.clipChromeTop}>
        <View style={styles.chip}>
          <Music size={10} color="#fff" />
          <Text style={styles.chipText}>{vibeLabel[vibe].toUpperCase()}</Text>
        </View>
      </View>
      <View style={styles.clipChromeBottom}>
        <Text style={styles.clipWordmark}>CLIPPAR</Text>
        <Text style={styles.clipCourse} numberOfLines={1}>
          {courseName ? `${courseName} · YOUR REEL` : 'YOUR REEL'}
        </Text>
      </View>
    </View>
  );
}

/** Load + loop the vibe's bundled track for the life of the playback view. */
function useVibeMusic(vibe: ReelVibe) {
  useEffect(() => {
    let alive = true;
    let sound: Audio.Sound | null = null;
    (async () => {
      try {
        const track = vibeOptions.find((v) => v.id === vibe)?.musicAsset;
        if (!track) return;
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const created = await Audio.Sound.createAsync(track, {
          isLooping: true,
          volume: 0.85,
          shouldPlay: true,
        });
        if (!alive) {
          created.sound.unloadAsync().catch(() => {});
          return;
        }
        sound = created.sound;
      } catch (err) {
        // Music is garnish — a silent reel is still the aha.
        console.warn('[onboarding-aha] music failed:', err);
      }
    })();
    return () => {
      alive = false;
      sound?.unloadAsync().catch(() => {});
    };
  }, [vibe]);
}

const styles = StyleSheet.create({
  link: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
    paddingVertical: 4,
  },
  vibeHeading: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  vibeCard: {
    borderWidth: 2,
    borderRadius: theme.radius.lg,
    padding: 12,
    minHeight: 96,
    gap: 4,
  },
  vibeLabel: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  vibeTagline: {
    color: theme.colors.textTertiary,
    fontSize: 11,
    lineHeight: 14,
  },
  vibeCheck: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buildWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 26,
    paddingHorizontal: 24,
  },
  buildRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 4,
    borderColor: theme.colors.surfaceBorder,
    borderTopColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipFrame: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  clipChromeTop: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(10,10,15,0.7)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  clipChromeBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(10,10,15,0.65)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  clipWordmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 2,
  },
  clipCourse: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    flexShrink: 1,
  },
});
