/**
 * ASMR playback — a practice session as one continuous, rhythmic stream.
 *
 * Every (optionally club-filtered) shot plays for the SAME chosen length —
 * 0.5s / 1s / 2s / 3s per shot, persisted via lib/training — then the next
 * begins immediately. Uniform duration is the rhythm; there is no gap.
 * (The first build had this backwards: full-length clips separated by a
 * silence. Henry's correction, 30 Aug: the knob is how long each vid is.)
 *
 * When a clip runs longer than the chosen length the player shows a window
 * centred on the clip's middle. Auto-trim already centres the swing, so the
 * middle of a trimmed clip is the strike itself.
 *
 * Tap the video to pause on a shot; tap again to resume. "Edit" drops into
 * the editor in training mode for trimming/export.
 *
 * One player, sources swapped with replaceAsync — a fresh player per clip
 * re-runs AVPlayer setup on every shot and stutters exactly where this
 * screen must not.
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
  getPlayLengthMs,
  setPlayLengthMs,
  PLAY_LENGTH_OPTIONS_MS,
  playLengthLabel,
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
  const [playLengthMs, setPlayLengthMsState] = useState(1000);
  const [finished, setFinished] = useState(false);

  // The per-shot window timer. Pausing must cancel it (and resume must
  // restart it with the REMAINING time) or a pause still advances mid-gaze.
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowStartSec = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const playLengthRef = useRef(playLengthMs);
  playLengthRef.current = playLengthMs;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  useEffect(() => {
    const clubHole = club ? parseInt(club, 10) : undefined;
    if (!roundId) return;
    listTrainingClips(roundId, Number.isNaN(clubHole as number) ? undefined : clubHole)
      .then(setClips)
      .catch(() => setClips([]));
    getPlayLengthMs().then(setPlayLengthMsState).catch(() => {});
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
  });

  const advance = useCallback(() => {
    const list = clipsRef.current;
    if (!list) return;
    const next = indexRef.current + 1;
    if (next >= list.length) {
      setFinished(true);
      player.pause();
      return;
    }
    setIndex(next);
  }, [player]);

  const armWindowTimer = useCallback(
    (ms: number) => {
      if (windowTimer.current) clearTimeout(windowTimer.current);
      windowTimer.current = setTimeout(() => {
        if (!pausedRef.current) advance();
      }, Math.max(100, ms));
    },
    [advance]
  );

  // Load each clip: seek to a window centred on the middle, play, and arm
  // the timer that ends the window. duration comes from the PLAYER once the
  // source is loaded — never from duration_seconds in SQLite, which records
  // the REQUESTED trim width, not the produced file (the reel-scorecard
  // lesson, reports/cto/2026-08-27.md §1.1).
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    (async () => {
      try {
        await player.replaceAsync(current.fileUri);
        if (cancelled) return;
        const L = playLengthRef.current / 1000;
        const dur = Number.isFinite(player.duration) ? player.duration : 0;
        const start = dur > L ? Math.max(0, dur / 2 - L / 2) : 0;
        windowStartSec.current = start;
        player.currentTime = start;
        if (!pausedRef.current) {
          player.play();
          armWindowTimer(playLengthRef.current);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (windowTimer.current) clearTimeout(windowTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // A clip shorter than the window ends naturally before the timer — advance
  // then too, so short clips don't hang as freeze-frames.
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      if (pausedRef.current) return;
      if (windowTimer.current) clearTimeout(windowTimer.current);
      advance();
    });
    return () => sub.remove();
  }, [player, advance]);

  const togglePause = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPaused((p) => {
      const next = !p;
      if (next) {
        player.pause();
        if (windowTimer.current) clearTimeout(windowTimer.current);
      } else if (finished) {
        setFinished(false);
        setIndex(0);
      } else {
        // Resume with the REMAINING window, not a fresh one.
        const elapsedMs = Math.max(0, (player.currentTime - windowStartSec.current) * 1000);
        player.play();
        armWindowTimer(playLengthRef.current - elapsedMs);
      }
      return next;
    });
  }, [player, finished, armWindowTimer]);

  const skip = useCallback(
    (dir: 1 | -1) => {
      if (!clips) return;
      if (windowTimer.current) clearTimeout(windowTimer.current);
      setFinished(false);
      setIndex((i) => Math.min(clips.length - 1, Math.max(0, i + dir)));
    },
    [clips]
  );

  const choosePlayLength = useCallback((ms: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPlayLengthMsState(ms);
    void setPlayLengthMs(ms);
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

        {/* Bottom: per-shot length picker + transport */}
        <View style={{ position: 'absolute', bottom: insets.bottom + 16, left: 0, right: 0, gap: 14 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
            {PLAY_LENGTH_OPTIONS_MS.map((ms) => (
              <Pressable
                key={ms}
                onPress={() => choosePlayLength(ms)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16,
                  backgroundColor: playLengthMs === ms ? '#fff' : 'rgba(0,0,0,0.55)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
                }}
              >
                <Text style={{ color: playLengthMs === ms ? '#000' : '#fff', fontSize: 13, fontWeight: '700' }}>
                  {playLengthLabel(ms)} per shot
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
