/**
 * ASMR playback — a practice session as one continuous, satisfying stream.
 *
 * Every (optionally club-filtered) shot plays back-to-back with a chosen gap
 * between them — 0.5s / 1s / 2s / 3s, persisted via lib/training. Tap the
 * video to pause; tap again to resume. "Open this shot" drops into the editor
 * in training mode for trimming/export of the clip on screen.
 *
 * One player, sources swapped with replaceAsync — mounting a fresh player per
 * clip re-runs the AVPlayer setup on every shot and stutters exactly where
 * this screen must not (the whole point is rhythm).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { X, Pause, Play, SkipForward, SkipBack, Scissors } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  clubForHole,
  getPlaybackIntervalMs,
  setPlaybackIntervalMs,
  INTERVAL_OPTIONS_MS,
  intervalLabel,
  listTrainingClips,
  type TrainingClip,
} from '@/lib/training';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ExpoVideo = isNative ? (require('expo-video') as typeof import('expo-video')) : null;

export default function TrainingPlayScreen() {
  const { roundId, club } = useLocalSearchParams<{ roundId: string; club?: string }>();
  const insets = useSafeAreaInsets();

  const [clips, setClips] = useState<TrainingClip[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [finished, setFinished] = useState(false);

  // The between-shots gap timer. Ref'd so pause can cancel a pending advance
  // — otherwise pausing during the gap still jumps to the next shot.
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const clubHole = club ? parseInt(club, 10) : undefined;
    if (!roundId) return;
    listTrainingClips(roundId, Number.isNaN(clubHole as number) ? undefined : clubHole)
      .then(setClips)
      .catch(() => setClips([]));
    getPlaybackIntervalMs().then(setIntervalMs).catch(() => {});
  }, [roundId, club]);

  const current = clips?.[index] ?? null;

  if (!isNative || !ExpoVideo) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff' }}>Playback needs a phone.</Text>
      </View>
    );
  }
  const { useVideoPlayer, VideoView } = ExpoVideo;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const player = useVideoPlayer(current?.fileUri ?? null, (p) => {
    p.loop = false;
    p.play();
  });

  // Swap sources when the index moves. replaceAsync keeps the same native
  // player alive, which is what keeps the stream smooth.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    (async () => {
      try {
        await player.replaceAsync(current.fileUri);
        if (!cancelled && !pausedRef.current) player.play();
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Advance on natural end, after the chosen gap.
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      if (pausedRef.current || !clips) return;
      const next = indexRef.current + 1;
      if (next >= clips.length) {
        setFinished(true);
        return;
      }
      gapTimer.current = setTimeout(() => {
        if (!pausedRef.current) setIndex(next);
      }, intervalMs);
    });
    return () => {
      sub.remove();
      if (gapTimer.current) clearTimeout(gapTimer.current);
    };
  }, [player, clips, intervalMs]);

  const togglePause = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPaused((p) => {
      const next = !p;
      if (next) {
        player.pause();
        if (gapTimer.current) clearTimeout(gapTimer.current);
      } else {
        if (finished) {
          setFinished(false);
          setIndex(0);
        } else {
          player.play();
        }
      }
      return next;
    });
  }, [player, finished]);

  const skip = useCallback(
    (dir: 1 | -1) => {
      if (!clips) return;
      if (gapTimer.current) clearTimeout(gapTimer.current);
      setFinished(false);
      setIndex((i) => Math.min(clips.length - 1, Math.max(0, i + dir)));
    },
    [clips]
  );

  const chooseInterval = useCallback((ms: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIntervalMs(ms);
    void setPlaybackIntervalMs(ms);
  }, []);

  const openInEditor = useCallback(() => {
    player.pause();
    setPaused(true);
    router.push(`/round/editor?roundId=${roundId}&review=1&training=1`);
  }, [player, roundId]);

  const currentClub = current ? clubForHole(current.holeNumber) : null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Tap anywhere on the video = pause/resume. The ASMR contract. */}
        <Pressable onPress={togglePause} style={{ flex: 1 }}>
          {current ? (
            <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {clips === null ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: 'rgba(255,255,255,0.7)' }}>No shots in this session yet.</Text>
              )}
            </View>
          )}

          {(paused || finished) && current && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' }}>
              <Play size={64} color="rgba(255,255,255,0.9)" fill="rgba(255,255,255,0.9)" />
              {finished && (
                <Text style={{ color: '#fff', marginTop: 12, fontWeight: '600' }}>Session over — tap to replay</Text>
              )}
            </View>
          )}
        </Pressable>

        {/* Top: position + close */}
        <View style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
              {currentClub?.label ?? 'Practice'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 }}>
              {clips ? `${Math.min(index + 1, clips.length)} / ${clips.length}` : '—'}
            </Text>
          </View>
          <Pressable onPress={() => router.back()} hitSlop={12} style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 20, padding: 10 }}>
            <X size={18} color="#fff" />
          </Pressable>
        </View>

        {/* Bottom: interval picker + transport */}
        <View style={{ position: 'absolute', bottom: insets.bottom + 16, left: 0, right: 0, gap: 14 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
            {INTERVAL_OPTIONS_MS.map((ms) => (
              <Pressable
                key={ms}
                onPress={() => chooseInterval(ms)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16,
                  backgroundColor: intervalMs === ms ? '#fff' : 'rgba(0,0,0,0.55)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
                }}
              >
                <Text style={{ color: intervalMs === ms ? '#000' : '#fff', fontSize: 13, fontWeight: '700' }}>
                  {intervalLabel(ms)} gap
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34 }}>
            <Pressable onPress={() => skip(-1)} hitSlop={12}>
              <SkipBack size={26} color="#fff" />
            </Pressable>
            <Pressable onPress={togglePause} hitSlop={12} style={{ backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 34, padding: 16 }}>
              {paused || finished ? <Play size={28} color="#fff" fill="#fff" /> : <Pause size={28} color="#fff" fill="#fff" />}
            </Pressable>
            <Pressable onPress={() => skip(1)} hitSlop={12}>
              <SkipForward size={26} color="#fff" />
            </Pressable>
            <Pressable onPress={openInEditor} hitSlop={12} style={{ position: 'absolute', right: 24, alignItems: 'center', gap: 3 }}>
              <Scissors size={20} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>Edit</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}
