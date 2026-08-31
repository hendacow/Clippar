/**
 * Import existing videos into a practice session.
 *
 * The second capture path Henry asked for: "it needs to work with importing
 * videos or live record". Pick a club, pick videos from Photos, done — the
 * clips land in the session exactly as filmed shots do (needs_trim=1), and
 * the editor auto-trims them through the same detection pass when review
 * opens, so imported shots get swing-centred like everything else.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, FolderOpen } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { CLUBS, importShotsToSession, ownsTrainingRound, type TrainingClub } from '@/lib/training';

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

  // Same gate, and the same shape, as app/training/record.tsx. `roundId` comes
  // from the URL and app.config.js registers a scheme, so this route is
  // externally reachable — and `pick()` opens the OS photo library, which is a
  // privacy prompt that must not fire for a round nothing has checked. That is
  // exactly the mistake fixed on the capture screen; this is its sibling, and
  // it did not get the fix at the time.
  //
  // The verdict carries the id it was computed for and `owned` is derived in
  // render, so an in-place param change invalidates the old answer in the same
  // commit that introduces the new id.
  const [verdict, setVerdict] = useState<{ roundId: string; owned: boolean } | null>(null);
  const owned: boolean | null = !roundId
    ? false
    : verdict?.roundId === roundId
      ? verdict.owned
      : null;
  useEffect(() => {
    if (!roundId) return;
    let alive = true;
    ownsTrainingRound(roundId)
      .then((ok) => alive && setVerdict({ roundId, owned: ok }))
      .catch(() => alive && setVerdict({ roundId, owned: false }));
    return () => {
      alive = false;
    };
  }, [roundId]);

  const pick = useCallback(async () => {
    // Ownership decides BEFORE the photo library opens, not after.
    if (!ImagePicker || !roundId || owned !== true || busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // Ask for Photos library access BEFORE the picker: with it, the picker
      // takes its fast path (PHAssetResourceManager streaming — patched to
      // allow iCloud download, see patches/expo-image-picker) instead of the
      // loadFileRepresentation path that threw PHPhotosError 3164 on Henry's
      // offloaded videos. A denial is not a blocker — the picker still works
      // for on-device videos without it.
      try {
        const MediaLibrary = require('expo-media-library') as typeof import('expo-media-library');
        await MediaLibrary.requestPermissionsAsync();
      } catch {}
      // preferredAssetRepresentationMode 'current' hands over the original
      // file instead of forcing an AVFoundation transcode — the transcode is
      // the slow step that makes big iCloud videos stall out of the picker.
      const pickerOptions = {
        mediaTypes: ['videos'] as import('expo-image-picker').MediaType[],
        allowsMultipleSelection: true,
        quality: 1,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      };
      let result: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
      try {
        result = await ImagePicker.launchImageLibraryAsync(pickerOptions);
      } catch (firstErr) {
        // The picker downloads iCloud assets itself and resumes a partial
        // download on retry — so retry once before involving the user at
        // all. The first version of this catch told the user to go download
        // in Photos manually: the app refusing to do something it is allowed
        // to do, and a guess at the cause besides (the same mistake as the
        // record screen's old 'check your free storage' — rebuilt here the
        // same day it was fixed there, caught by Henry within hours).
        try {
          result = await ImagePicker.launchImageLibraryAsync(pickerOptions);
        } catch (err) {
          const reason = err instanceof Error && err.message ? err.message : String(firstErr ?? err);
          Alert.alert('Could not fetch those videos', `${reason}\n\nTap Choose videos to try again — iCloud downloads resume where they left off.`);
          return;
        }
      }
      if (result.canceled || result.assets.length === 0) return;
      const saved = await importShotsToSession(
        roundId,
        club.holeNumber,
        result.assets.map((a) => ({ uri: a.uri, durationMs: a.duration }))
      );
      // A refusal is not a success. `importShotsToSession` fails closed — it
      // returns 0 both for a round this account does not own AND for a
      // transient session failure — and reporting either as "0 shots imported"
      // with a success haptic told a golfer their own import had worked when
      // it had silently not.
      if (saved === 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Nothing imported',
          'Those videos could not be added to this practice session. Try again in a moment.'
        );
        return;
      }
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
  }, [roundId, club, busy, owned]);

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
