/**
 * Import existing videos into a practice session.
 *
 * The second capture path Henry asked for: "it needs to work with importing
 * videos or live record". Pick a club, pick videos from Photos, done — the
 * clips land in the session exactly as filmed shots do (needs_trim=1), and
 * the editor auto-trims them through the same detection pass when review
 * opens, so imported shots get swing-centred like everything else.
 */
import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, FolderOpen } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { CLUBS, importShotsToSession, type TrainingClub } from '@/lib/training';

const ImagePicker = (() => {
  try {
    return require('expo-image-picker') as typeof import('expo-image-picker');
  } catch {
    return null;
  }
})();

export default function TrainingImportScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const insets = useSafeAreaInsets();
  const [club, setClub] = useState<TrainingClub>(CLUBS[7]); // 7 iron default, same as capture
  const [busy, setBusy] = useState(false);

  const pick = useCallback(async () => {
    if (!ImagePicker || !roundId || busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      let result: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'],
          allowsMultipleSelection: true,
          quality: 1,
        });
      } catch {
        // iCloud-only assets can fail to stream down (PHPhotosErrorDomain
        // 3164) — the same failure app/round/import.tsx handles. Say what to
        // do rather than presenting a generic error.
        Alert.alert(
          'Video stored in iCloud',
          'Open the Photos app and download the videos to your phone first, then import them here.'
        );
        return;
      }
      if (result.canceled || result.assets.length === 0) return;
      const saved = await importShotsToSession(
        roundId,
        club.holeNumber,
        result.assets.map((a) => ({ uri: a.uri, durationMs: a.duration }))
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        `${saved} shot${saved === 1 ? '' : 's'} imported`,
        `Saved as ${club.label}. They'll be trimmed to the swing automatically in review.`,
        [
          { text: 'Import more', style: 'cancel' },
          {
            text: 'Review now',
            onPress: () => router.replace(`/round/editor?roundId=${roundId}&review=1&training=1`),
          },
        ]
      );
    } finally {
      setBusy(false);
    }
  }, [roundId, club, busy]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, padding: 20 }}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            <ChevronLeft size={20} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Back</Text>
          </Pressable>

          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary }}>Import shots</Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginTop: 4, marginBottom: 24 }}>
            Pick videos from your Photos library. Which club were you hitting?
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
            {CLUBS.map((c) => {
              const active = c.key === club.key;
              return (
                <Pressable
                  key={c.key}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setClub(c);
                  }}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18,
                    backgroundColor: active ? theme.colors.primary : theme.colors.surface,
                    borderWidth: 1, borderColor: active ? theme.colors.primary : theme.colors.surfaceBorder,
                  }}
                >
                  <Text style={{ color: active ? '#fff' : theme.colors.textSecondary, fontSize: 14, fontWeight: '600' }}>
                    {c.short}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={pick}
            disabled={busy}
            style={({ pressed }) => ({
              backgroundColor: theme.colors.primary,
              borderRadius: theme.radius.lg,
              padding: 18,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              opacity: pressed || busy ? 0.85 : 1,
            })}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <FolderOpen size={20} color="#fff" />}
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              Choose videos — {club.label}
            </Text>
          </Pressable>

          <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 16, textAlign: 'center' }}>
            Different clubs? Import each club's videos in its own batch, or move
            single shots between clubs later in review (hold a shot → Move).
          </Text>
        </ScrollView>
      </View>
    </>
  );
}
