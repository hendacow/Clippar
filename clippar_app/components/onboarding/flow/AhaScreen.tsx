/**
 * Screen 8 — the REAL aha: pick up to 5 swings from the camera roll and
 * watch them become ONE reel (trimmed clips stitched together + vibe music
 * + overlay chrome). This is the compliant 3.1.2(c) value demonstration
 * that makes the paywall honest.
 *
 * Fallback ladder (never dead-ends, never claims a sample is "yours").
 * Per clip (each picked clip runs the same ladder independently):
 *   1. detectAndTrim finds the swing → trimmed clip.
 *   2. Detection found:false but native module present → trim the middle ~6s
 *      via trimVideo (or play as-is when short) → still THEIR clip.
 *   3. Clip-level failure (detection threw / per-clip 30s timeout / module
 *      absent) → SKIP that clip; the rest of the batch continues.
 * Batch (successes collected in pick order):
 *   4. 1 success → play it exactly as the single-clip flow always has.
 *   5. ≥2 successes → stitchClips → play the stitched reel. If the stitch
 *      itself fails, play the first successful clip instead — still theirs.
 *   6. 0 successes, overall timeout (30s + 15s/clip), or Expo Go →
 *      "Watch a sample" (MockReel + music) with honest sample copy.
 *   7. Picker cancelled / iCloud download failed → back to the chooser,
 *      which always offers the sample path forward.
 *
 * v1 deliberately does NOT call composeReel — trimmed clips + music +
 * overlay UI are the aha; full composition happens in the real app flow.
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
  stitchClips,
  isShotDetectorAvailable,
} from '@/modules/shot-detector';
import { FlowButton } from '../sales/primitives';
import { FlowScreen, Rise, H1, Sub } from './FlowKit';
import { MockReel } from './MockReel';
import {
  computeFallbackTrimWindow,
  computeOverallBuildTimeoutMs,
  dedupeSelectedAssets,
  collectSuccessfulClips,
  resolveBatchOutcome,
  buildProgressLine,
  MAX_AHA_CLIPS,
  type AhaBuildProgress,
} from './ahaTrim';
import { vibeOptions, vibeLabel } from '@/constants/onboardingV2';
import { intentEcho, shotEcho, type ReelVibe } from '@/lib/onboardingProfile';
import type { FlowScreenProps, AhaOutcome } from './Screens';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const MIN_BUILD_MS = 2400; // labor illusion floor — never flash the loader
const PER_CLIP_DETECT_TIMEOUT_MS = 30_000; // historical single-clip insurance, now per clip

type Phase =
  | { name: 'choose' }
  | { name: 'building'; progress: AhaBuildProgress | null }
  | { name: 'playback'; outcome: AhaOutcome; videoUri: string | null; clipCount: number };

type PickedClip = { uri: string; duration: number | null };

/**
 * One clip through the historical single-clip ladder: detectAndTrim hit →
 * trimmed uri; miss with native present → middle-~6s trimVideo (or as-is
 * when short); anything else (throw, per-clip timeout, Expo Go) → null,
 * meaning SKIP this clip — a bad clip never kills the batch.
 */
async function trimSingleClip(clip: PickedClip): Promise<string | null> {
  try {
    // Insurance: a huge 4K clip (or a wedged native promise) must never
    // stall the batch — after 30s this clip is skipped, same as a
    // detection failure.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('aha-clip-timeout')), PER_CLIP_DETECT_TIMEOUT_MS)
    );
    const detection = await Promise.race([
      detectAndTrim(clip.uri, 3000, 2000, []),
      timeout,
    ]);
    if (detection.found && detection.trimmedUri) {
      return detection.trimmedUri;
    }
    if (isShotDetectorAvailable()) {
      // Detection genuinely found nothing — keep THEIR clip anyway,
      // trimmed to the middle ~6s so it still feels cut.
      const win = computeFallbackTrimWindow(clip.duration);
      if (win) {
        const trimmed = await trimVideo(clip.uri, win.startMs, win.endMs);
        return trimmed.trimmedUri ?? clip.uri;
      }
      return clip.uri;
    }
    // Native module absent → null → batch resolves to the sample fallback.
    return null;
  } catch (err) {
    console.warn('[onboarding-aha] clip processing failed:', err);
    return null;
  }
}

/**
 * Sequential per-clip processing (memory-safe: one native job at a time),
 * then stitch when ≥2 clips survived. Returns the uri to play and how many
 * clips it contains, or null → sample fallback.
 */
async function buildReelFromClips(
  clips: PickedClip[],
  onProgress: (p: AhaBuildProgress) => void
): Promise<{ uri: string; clipCount: number } | null> {
  const results: Array<string | null> = [];
  for (let i = 0; i < clips.length; i++) {
    onProgress({ current: i + 1, total: clips.length, stage: 'cutting' });
    results.push(await trimSingleClip(clips[i]));
  }
  const successes = collectSuccessfulClips(results);
  const outcome = resolveBatchOutcome(successes);
  if (outcome.kind === 'sample') return null;
  if (outcome.kind === 'single') return { uri: outcome.uri, clipCount: 1 };

  onProgress({ current: outcome.uris.length, total: outcome.uris.length, stage: 'stitching' });
  try {
    const stitched = await stitchClips(outcome.uris);
    return { uri: stitched.stitchedUri, clipCount: outcome.uris.length };
  } catch (err) {
    // Stitch failed but the trims succeeded — play the first cut clip
    // rather than dropping all the way to the sample.
    console.warn('[onboarding-aha] stitch failed, playing first clip:', err);
    return { uri: outcome.uris[0], clipCount: 1 };
  }
}

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
          allowsMultipleSelection: true,
          selectionLimit: MAX_AHA_CLIPS,
          orderedSelection: true, // stitch order = the order they tapped
          quality: 1,
        });
      } catch (err) {
        // iCloud-only asset that failed to stream down, or picker hiccup
        // (see app/round/import.tsx for the field history). Not fatal —
        // the chooser stays up with the sample path available.
        console.warn('[onboarding-aha] picker failed:', err);
        result = null;
      }
      const assets = result && !result.canceled ? result.assets ?? [] : [];
      const picked: PickedClip[] = dedupeSelectedAssets(assets).map((a) => ({
        uri: a.uri,
        duration: a.duration ?? null,
      }));
      if (picked.length === 0) return; // cancelled → stay on chooser (way forward: sample)

      setPhase({
        name: 'building',
        progress:
          picked.length > 1 ? { current: 1, total: picked.length, stage: 'cutting' } : null,
      });
      const startedAt = Date.now();

      let built: { uri: string; clipCount: number } | null = null;
      // Once the race settles (timeout OR completion), a still-running build
      // must never flip the screen back to "building" via a late progress
      // callback.
      let buildActive = true;
      try {
        // Insurance: the WHOLE batch (all trims + the stitch) must never
        // strand the user on "Building your reel…" — after 30s + 15s/clip
        // we fall to the sample path, same as a detection failure.
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('aha-build-timeout')),
            computeOverallBuildTimeoutMs(picked.length)
          )
        );
        built = await Promise.race([
          buildReelFromClips(picked, (progress) => {
            if (buildActive) setPhase({ name: 'building', progress });
          }),
          timeout,
        ]);
      } catch (err) {
        console.warn('[onboarding-aha] reel build failed:', err);
        built = null;
      } finally {
        buildActive = false;
      }

      // Hold the labor-illusion beat even when processing was instant.
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_BUILD_MS) {
        await new Promise((r) => setTimeout(r, MIN_BUILD_MS - elapsed));
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (built) {
        setPhase({ name: 'playback', outcome: 'real', videoUri: built.uri, clipCount: built.clipCount });
      } else {
        setPhase({ name: 'playback', outcome: 'sample', videoUri: null, clipCount: 0 });
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const watchSample = useCallback(() => {
    Haptics.selectionAsync();
    setPhase({ name: 'playback', outcome: 'sample', videoUri: null, clipCount: 0 });
  }, []);

  if (phase.name === 'building') {
    return <BuildingReel answers={answers} progress={phase.progress} />;
  }

  if (phase.name === 'playback') {
    return (
      <ReelPlayback
        outcome={phase.outcome}
        videoUri={phase.videoUri}
        clipCount={phase.clipCount}
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
      title="Pick up to 5 swings from your camera roll — we'll cut them into one reel."
      sub="Any clips with a swing in them. We'll find the good parts."
      footer={
        <>
          <FlowButton label="Pick your clips" onPress={pickClip} />
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

function BuildingReel({
  answers,
  progress,
}: {
  answers: FlowScreenProps['answers'];
  progress: AhaBuildProgress | null;
}) {
  const reduceMotion = useReducedMotion();
  const spin = useSharedValue(0);
  const [done, setDone] = useState(-1);

  const course = answers.homeCourseName ?? 'your course';
  const shots = answers.memorableShot ? shotEcho[answers.memorableShot] : 'the good part';
  const intent = answers.intent ? intentEcho[answers.intent] : 'reliving your best shots';
  const lines = [
    // Single clip keeps the historical "Finding the swing…"; multi-clip
    // reflects real batch progress ("Cutting swing 2 of 4…").
    buildProgressLine(progress),
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
  clipCount,
  vibe,
  courseName,
  onKeepGoing,
  onPickAnother,
}: {
  outcome: AhaOutcome;
  videoUri: string | null;
  clipCount: number;
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
              {clipCount > 1
                ? `Your ${clipCount} swings, stitched into one reel and cut to ${vibeLabel[vibe]}.`
                : `Your swing, cut to ${vibeLabel[vibe]}.`}
              {courseName ? ` ${courseName} on the end-card.` : ''}
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
