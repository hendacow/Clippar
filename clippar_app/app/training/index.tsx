/**
 * Practice hub — start a session, and look back on past ones by date.
 *
 * "I can look back on those training dates and see how your drivers or how
 * your seven irons were looking" — so the list is grouped by date, each row
 * summarises shots per club, and tapping through opens either the ASMR
 * player (watch) or the editor in training mode (work).
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Play, ListVideo, Plus, ChevronLeft, FolderOpen, X } from 'lucide-react-native';
import { isPracticeSetupSeen, markPracticeSetupSeen } from '@/lib/kitMoments';
import { Linking } from 'react-native';
import { config } from '@/constants/config';
import { theme } from '@/constants/theme';
import {
  CLUBS,
  clubForHole,
  listTrainingSessions,
  startTrainingSession,
  trainingShotCounts,
  type TrainingSessionRef,
} from '@/lib/training';

interface SessionRow extends TrainingSessionRef {
  total: number;
  /** e.g. "Dr ×6 · 7i ×12 · 9i ×8" in bag order. */
  summary: string;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function TrainingHubScreen() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [starting, setStarting] = useState(false);
  // Club filter for the history list: null = every session; a holeNumber
  // narrows to sessions where that club was hit, and the row summary leads
  // with it. This is the "see how your 7-irons were looking" view.
  const [filterHole, setFilterHole] = useState<number | null>(null);
  // Earned kit moment (lib/kitMoments): the range setup, shown once after a
  // real session exists — an observation about how this footage gets made,
  // not a pitch. Dismiss is permanent.
  const [showSetupCard, setShowSetupCard] = useState(false);
  useEffect(() => {
    isPracticeSetupSeen().then((seen) => setShowSetupCard(!seen)).catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    let alive = true;
    (async () => {
      const sessions = await listTrainingSessions();
      const built: SessionRow[] = [];
      for (const s of sessions) {
        const counts = await trainingShotCounts(s.roundId);
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        const summary = CLUBS.filter((c) => (counts.get(c.holeNumber) ?? 0) > 0)
          .map((c) => `${c.short} ×${counts.get(c.holeNumber)}`)
          .join(' · ');
        built.push({ ...s, total, summary });
      }
      if (alive) setRows(built);
    })().catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(refresh);

  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const id = await startTrainingSession();
      router.push(`/training/record?roundId=${id}`);
    } catch {
      Alert.alert('Could not start', 'Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  }, [starting]);

  // Import goes into today's session, creating one if the day is fresh —
  // "film at the range or import from Photos" are two doors into the same
  // session, not two kinds of session.
  const handleImport = useCallback(async () => {
    if (starting) return;
    const todaySession = rows?.find((r) => dateLabel(r.startedAt) === 'Today');
    if (todaySession) {
      router.push(`/training/import?roundId=${todaySession.roundId}`);
      return;
    }
    setStarting(true);
    try {
      const id = await startTrainingSession();
      router.push(`/training/import?roundId=${id}`);
    } catch {
      Alert.alert('Could not start', 'Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  }, [starting, rows]);

  const today = rows?.find((r) => dateLabel(r.startedAt) === 'Today');
  const visible = (rows ?? []).filter((r) => {
    if (filterHole == null) return true;
    return r.summary.includes(`${clubForHole(filterHole)?.short} ×`);
  });

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, padding: 20, paddingBottom: insets.bottom + 40 }}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            <ChevronLeft size={20} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Back</Text>
          </Pressable>

          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary }}>Practice</Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginTop: 4, marginBottom: 20 }}>
            Range sessions, filmed shot by shot.
          </Text>

          <Pressable
            onPress={handleStart}
            disabled={starting}
            style={({ pressed }) => ({
              backgroundColor: theme.colors.primary,
              borderRadius: theme.radius.lg,
              padding: 18,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              opacity: pressed || starting ? 0.85 : 1,
              marginBottom: 12,
            })}
          >
            {starting ? <ActivityIndicator color="#fff" /> : <Plus size={22} color="#fff" strokeWidth={2.6} />}
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              {today ? 'Start another session' : 'Start practice session'}
            </Text>
          </Pressable>

          <Pressable
            onPress={handleImport}
            disabled={starting}
            style={({ pressed }) => ({
              borderRadius: theme.radius.lg,
              padding: 16,
              backgroundColor: theme.colors.surface,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              opacity: pressed || starting ? 0.85 : 1,
              marginBottom: 12,
            })}
          >
            <FolderOpen size={18} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
              Import shots from Photos
            </Text>
          </Pressable>

          {today && (
            <Pressable
              onPress={() => router.push(`/training/record?roundId=${today.roundId}`)}
              style={({ pressed }) => ({
                borderRadius: theme.radius.lg,
                padding: 16,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                opacity: pressed ? 0.85 : 1,
                marginBottom: 20,
              })}
            >
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '700' }}>Continue today's session</Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                {today.total} shot{today.total === 1 ? '' : 's'} so far{today.summary ? ` — ${today.summary}` : ''}
              </Text>
            </Pressable>
          )}

          {/* Club filter for history — the "how were my 7-irons" lens. */}
          {rows !== null && rows.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 8 }}>
              <Pressable
                onPress={() => setFilterHole(null)}
                style={{
                  paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
                  backgroundColor: filterHole == null ? theme.colors.primary : theme.colors.surface,
                  borderWidth: 1, borderColor: filterHole == null ? theme.colors.primary : theme.colors.surfaceBorder,
                }}
              >
                <Text style={{ color: filterHole == null ? '#fff' : theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>All clubs</Text>
              </Pressable>
              {CLUBS.map((c) => (
                <Pressable
                  key={c.key}
                  onPress={() => setFilterHole(filterHole === c.holeNumber ? null : c.holeNumber)}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
                    backgroundColor: filterHole === c.holeNumber ? theme.colors.primary : theme.colors.surface,
                    borderWidth: 1, borderColor: filterHole === c.holeNumber ? theme.colors.primary : theme.colors.surfaceBorder,
                  }}
                >
                  <Text style={{ color: filterHole === c.holeNumber ? '#fff' : theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>{c.short}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {showSetupCard && rows !== null && rows.length > 0 && (
            <View style={{ borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, marginBottom: 14 }}>
              <Pressable
                onPress={() => Linking.openURL(config.shop.mountUrl).catch(() => {})}
                style={({ pressed }) => ({ padding: 16, paddingRight: 40, gap: 4, opacity: pressed ? 0.85 : 1 })}
              >
                <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700' }}>
                  Phone on the bag. Clicker in the glove.
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                  That's the whole rig Henry films these with — nothing to hold, nothing to tap.
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setShowSetupCard(false);
                  void markPracticeSetupSeen();
                }}
                hitSlop={10}
                style={{ position: 'absolute', top: 10, right: 10 }}
              >
                <X size={16} color={theme.colors.textTertiary} />
              </Pressable>
            </View>
          )}

          {rows === null ? (
            <ActivityIndicator style={{ marginTop: 30 }} color={theme.colors.textSecondary} />
          ) : visible.length === 0 ? (
            <Text style={{ color: theme.colors.textTertiary, fontSize: 14, textAlign: 'center', marginTop: 30 }}>
              {rows.length === 0 ? 'No practice sessions yet.' : 'No sessions with that club yet.'}
            </Text>
          ) : (
            visible.map((r) => (
              <View
                key={r.roundId}
                style={{
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  padding: 16,
                  marginBottom: 10,
                }}
              >
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 15 }}>{dateLabel(r.startedAt)}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 3 }}>
                  {r.total} shot{r.total === 1 ? '' : 's'}{r.summary ? ` — ${r.summary}` : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <Pressable
                    onPress={() =>
                      router.push(
                        `/training/play?roundId=${r.roundId}${filterHole != null ? `&club=${filterHole}` : ''}`
                      )
                    }
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.surfaceElevated, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 }}
                  >
                    <Play size={15} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>Watch</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push(`/round/editor?roundId=${r.roundId}&review=1&training=1`)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.surfaceElevated, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 }}
                  >
                    <ListVideo size={15} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>Review & export</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </>
  );
}
