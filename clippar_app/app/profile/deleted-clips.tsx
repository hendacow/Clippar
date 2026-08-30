/**
 * Recently deleted — the recovery half of a real delete.
 *
 * Deleting a clip in the editor used to be cosmetic (state only, never SQLite)
 * so a mis-tap cost nothing. Now that it persists, this screen is what stops
 * it costing a shot. Deliberately NOT gated behind __DEV__: it is a golfer's
 * safety net, not a debug harness.
 */
import { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Platform } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { RotateCcw, Trash2 } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { listBinnedClips, restoreClipFromBin, purgeClipFromBin, type BinnedClip } from '@/lib/clipBin';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

function whenDeleted(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export default function DeletedClipsScreen() {
  const [entries, setEntries] = useState<BinnedClip[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = useCallback(() => {
    if (!isNative) return;
    listBinnedClips()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, []);

  useFocusEffect(refresh);

  const restore = useCallback(
    async (id: number) => {
      setBusy(id);
      try {
        const ok = await restoreClipFromBin(id);
        Haptics.notificationAsync(
          ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
        );
        if (!ok) Alert.alert('Could not restore', 'It may already be back in its round.');
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh]
  );

  const purge = useCallback(
    (id: number) => {
      // The one irreversible action on this screen, so it is the one that asks.
      Alert.alert('Delete for good?', 'The video file is removed from this phone. This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete for good',
          style: 'destructive',
          onPress: async () => {
            setBusy(id);
            try {
              await purgeClipFromBin(id);
            } finally {
              setBusy(null);
              refresh();
            }
          },
        },
      ]);
    },
    [refresh]
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Recently deleted' }} />
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: 16 }}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
          Shots you deleted are kept here so you can put them back. The video stays on your
          phone until you remove it for good, or until it is pushed out by newer deletions.
        </Text>

        {entries.length === 0 ? (
          <Text style={{ color: theme.colors.textTertiary, fontSize: 15, textAlign: 'center', marginTop: 40 }}>
            Nothing deleted recently.
          </Text>
        ) : (
          entries.map((e) => {
            const id = Number(e.row?.id);
            return (
              <View
                key={id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.surfaceBorder,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    Hole {String(e.row?.hole_number ?? '?')} · shot {String(e.row?.shot_number ?? '?')}
                  </Text>
                  <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 2 }}>
                    Deleted {whenDeleted(e.deletedAt)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => restore(id)}
                  disabled={busy === id}
                  hitSlop={10}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }}
                >
                  <RotateCcw size={18} color={theme.colors.textPrimary} />
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' }}>Put back</Text>
                </Pressable>
                <Pressable onPress={() => purge(id)} disabled={busy === id} hitSlop={10} style={{ paddingLeft: 8 }}>
                  <Trash2 size={18} color={theme.colors.accentRed} />
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </>
  );
}
