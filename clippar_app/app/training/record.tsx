/**
 * Trainee mode — the range capture screen.
 *
 * Deliberately a thin wrapper around the SAME useCamera hook live rounds use:
 * detection, auto-trim, finalize gating, the KeepAwake lock, the disk
 * precheck and the honest failure alert are all inherited, not copied. What
 * this screen adds is a club selector instead of a hole counter — the
 * selected club's holeNumber is passed straight through as the "hole", which
 * is the whole trick of training mode (see lib/training.ts).
 *
 * Kept intentionally simpler than record.tsx: no BLE clicker, no volume
 * shutter, no zoom/lens switching in v1. Those live in a 2,000-line screen
 * shaped by months of on-course lessons; cloning them here would fork every
 * one of those lessons. The record button, the review path and delete-last
 * behave the same as live so nothing has to be relearned at the range.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { X, ListVideo, Undo2 } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { useCamera } from '@/hooks/useCamera';
import { useShutter } from '@/hooks/useShutter';
import { useIsFocused } from '@react-navigation/native';
import { CLUBS, listTrainingClips, type TrainingClub } from '@/lib/training';
import { deleteClipToBin } from '@/lib/clipBin';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const CameraView = isNative
  ? (require('expo-camera') as typeof import('expo-camera')).CameraView
  : null;

export default function TrainingRecordScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const insets = useSafeAreaInsets();

  const [club, setClub] = useState<TrainingClub>(CLUBS[7]); // 7 iron — the range default
  // shots already hit per club this session, hydrated from SQLite so a
  // resumed session numbers its next 7-iron correctly instead of restarting
  // at 1 and colliding with this morning's shots.
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [lastClipId, setLastClipId] = useState<number | null>(null);

  const countsRef = useRef(counts);
  countsRef.current = counts;
  const clubRef = useRef(club);
  clubRef.current = club;

  const camera = useCamera({
    roundId: roundId ?? '',
    holeNumber: club.holeNumber,
    shotNumber: (counts.get(club.holeNumber) ?? 0) + 1,
    onClipSaved: (clip) => {
      setCounts((prev) => {
        const next = new Map(prev);
        next.set(clip.holeNumber, (next.get(clip.holeNumber) ?? 0) + 1);
        return next;
      });
      if (clip.id != null) setLastClipId(clip.id);
    },
  });

  // Hydrate counts + permissions once. Opening this screen IS the commitment
  // to capture (it exists for nothing else), so prompting here matches the
  // spec-5.6 rule record.tsx follows: ask at the moment capture starts, not
  // when a tab renders.
  useEffect(() => {
    if (!roundId) return;
    listTrainingClips(roundId)
      .then((clips) => {
        const m = new Map<number, number>();
        for (const c of clips) m.set(c.holeNumber, (m.get(c.holeNumber) ?? 0) + 1);
        setCounts(m);
        const last = clips[clips.length - 1];
        if (last) setLastClipId(last.id);
      })
      .catch(() => {});
    void camera.requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundId]);

  const recordingBusy = camera.isRecording || camera.isFinalizing;

  // The BLE clicker, brought across from the live round (Henry, 1 Sep: "use
  // whatever changes you made in the actual live round"). This is the SAME
  // useShutter that fixed clicker-presses-acting-as-volume-buttons there —
  // volume/key interception plus BLE, resolved in the 1s click window.
  // `armed` is focus-gated: pushing the editor or playback over this screen
  // disarms interception, so volume buttons do their normal job everywhere
  // that isn't an armed capture surface (including ASMR playback).
  const isFocused = useIsFocused();
  const shutter = useShutter({ armed: isFocused });

  // Range gesture grammar, chosen not silently mapped: 1 press = start/stop
  // the shot (identical to the course); 2 presses = NEXT CLUB (the range's
  // analogue of next hole); 3 presses = nothing — there are no penalties at
  // the range, so a triple gets a soft acknowledgement rather than a
  // surprise. clubRef keeps the handler on the current club without
  // resubscribing per selection.
  useEffect(() => {
    if (!isFocused) return;
    shutter.clearPendingClicks();
    shutter.armVolumeGrace();
  }, [isFocused, shutter.clearPendingClicks, shutter.armVolumeGrace]);

  useEffect(() => {
    if (!isFocused) return;
    // Instant stop channel — identical contract to the round screen: a press
    // mid-recording stops NOW, and clearPendingClicks stops the same press
    // resolving into a "start" a second later.
    return shutter.onPress(() => {
      if (camera.isRecording) {
        shutter.clearPendingClicks();
        camera.toggleRecording();
      } else {
        Haptics.selectionAsync();
      }
    });
  }, [isFocused, shutter.onPress, shutter.clearPendingClicks, camera.isRecording, camera.toggleRecording]);

  useEffect(() => {
    if (!isFocused) return;
    return shutter.onClick(({ count }) => {
      if (camera.isRecording) return; // onPress already stopped it
      if (camera.isFinalizing) return; // same swallow as the round screen
      if (count === 1) {
        camera.toggleRecording();
      } else if (count === 2) {
        const i = CLUBS.findIndex((c) => c.key === clubRef.current.key);
        const next = CLUBS[(i + 1) % CLUBS.length];
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setClub(next);
      } else if (count === 3) {
        Haptics.selectionAsync(); // no penalties at the range — acknowledged, nothing else
      }
    });
  }, [isFocused, shutter.onClick, camera.isRecording, camera.isFinalizing, camera.toggleRecording]);

  const switchClub = useCallback(
    (next: TrainingClub) => {
      // Same contract as every round-mutating action in record.tsx: changing
      // the club mid-save would tag the in-flight clip with the NEW club.
      if (recordingBusy) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setClub(next);
    },
    [recordingBusy]
  );

  const handleRecordPress = useCallback(() => {
    if (camera.isFinalizing) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    camera.toggleRecording();
  }, [camera]);

  const handleDeleteLast = useCallback(() => {
    if (recordingBusy) {
      Alert.alert('Clip still saving', 'Wait a few seconds, then delete it.');
      return;
    }
    if (lastClipId == null || !roundId) return;
    Alert.alert('Delete last shot?', 'You can put it back from Profile → Recently deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const entry = await deleteClipToBin(lastClipId, roundId).catch(() => null);
          if (entry) {
            const hole = Number(entry.row.hole_number);
            setCounts((prev) => {
              const next = new Map(prev);
              next.set(hole, Math.max(0, (next.get(hole) ?? 1) - 1));
              return next;
            });
          }
          setLastClipId(null);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  }, [recordingBusy, lastClipId, roundId]);

  const handleReview = useCallback(() => {
    if (recordingBusy) {
      Alert.alert('Stop recording first', 'Let the clip finish saving before reviewing.');
      return;
    }
    router.push(`/round/editor?roundId=${roundId}&review=1&training=1`);
  }, [recordingBusy, roundId]);

  const handleEnd = useCallback(() => {
    if (recordingBusy) {
      Alert.alert('Stop recording first', 'Let the clip finish saving before ending the session.');
      return;
    }
    Alert.alert('End practice session?', 'You can review and export it any time from Practice.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'End session',
        onPress: () => {
          // The session was marked finished at creation (see
          // startTrainingSession) — ending it is purely navigation.
          router.back();
        },
      },
    ]);
  }, [recordingBusy, roundId]);

  if (isNative && camera.hasPermission === false) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, marginBottom: 16 }}>
          Camera access is needed to record practice shots.
        </Text>
        <Pressable onPress={camera.requestPermission} style={styles.retryBtn}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const shotsThisClub = counts.get(club.holeNumber) ?? 0;
  const totalShots = [...counts.values()].reduce((a, b) => a + b, 0);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {isNative && CameraView ? (
        <CameraView
          ref={camera.cameraRef}
          style={StyleSheet.absoluteFillObject}
          facing="back"
          mode="video"
          // The torch as the "recording in progress" light, exactly as on the
          // round screen — the range never turned it on (Henry, 4 Sep). Follows
          // isRecording so it is on the instant a clip starts and off when it ends.
          enableTorch={camera.isRecording}
        />
      ) : (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#111' }]} />
      )}

      {/* Top bar — session chip left, close right. Mirrors live's layout so
          nothing has to be relearned. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.chip}>
          <Text style={styles.chipTitle}>{club.label}</Text>
          <Text style={styles.chipSub}>
            Shot {shotsThisClub + (camera.isRecording ? 1 : 0) || 1} · {totalShots} total
          </Text>
        </View>
        <View style={[styles.chip, { backgroundColor: shutter.connected ? 'rgba(27,94,32,0.75)' : 'rgba(0,0,0,0.55)' }]}>
          <Text style={styles.chipSub}>{shutter.connected ? 'Clicker ✓' : 'No Clicker'}</Text>
        </View>
        <Pressable onPress={handleEnd} hitSlop={10} style={styles.chip}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <X size={16} color="#fff" />
            <Text style={styles.chipTitle}>End</Text>
          </View>
        </Pressable>
      </View>

      {/* Club selector — one horizontal row of chips, current club lit.
          Inert while a clip is recording/saving (see switchClub). */}
      <View style={[styles.clubRow, { bottom: insets.bottom + 128 }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {CLUBS.map((c) => {
            const active = c.key === club.key;
            const n = counts.get(c.holeNumber) ?? 0;
            return (
              <Pressable
                key={c.key}
                onPress={() => switchClub(c)}
                style={[styles.clubChip, active && styles.clubChipActive, recordingBusy && !active && { opacity: 0.4 }]}
              >
                <Text style={[styles.clubChipText, active && { color: '#000' }]}>{c.short}</Text>
                {n > 0 && <Text style={[styles.clubChipCount, active && { color: '#000' }]}>{n}</Text>}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Bottom controls — delete last · record · review */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 24 }]}>
        <Pressable onPress={handleDeleteLast} hitSlop={12} style={styles.sideBtn} disabled={lastClipId == null}>
          <Undo2 size={22} color={lastClipId == null ? 'rgba(255,255,255,0.3)' : '#fff'} />
          <Text style={[styles.sideLabel, lastClipId == null && { color: 'rgba(255,255,255,0.3)' }]}>Delete last</Text>
        </Pressable>

        <Pressable onPress={handleRecordPress} style={styles.recordOuter}>
          {camera.isFinalizing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={[styles.recordInner, camera.isRecording && styles.recordInnerActive]} />
          )}
        </Pressable>

        <Pressable onPress={handleReview} hitSlop={12} style={styles.sideBtn}>
          <ListVideo size={22} color="#fff" />
          <Text style={styles.sideLabel}>Review</Text>
        </Pressable>
      </View>

      {camera.isFinalizing && (
        <View style={[styles.savingPill, { bottom: insets.bottom + 104 }]}>
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Saving…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  retryBtn: { backgroundColor: theme.colors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
  chip: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  chipTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  chipSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 },
  clubRow: { position: 'absolute', left: 0, right: 0 },
  clubChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
  clubChipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  clubChipText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  clubChipCount: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  sideBtn: { alignItems: 'center', gap: 4, width: 84 },
  sideLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
  recordOuter: {
    width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  recordInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#E53935' },
  recordInnerActive: { width: 30, height: 30, borderRadius: 8 },
  savingPill: {
    position: 'absolute', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14,
  },
});
