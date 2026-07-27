/**
 * RecordingSettingsSheet — bottom sheet opened from the gear button on the
 * live recording screen. Hosts the mid-round controls that don't belong in
 * the always-visible bottom bar:
 *   • Recording light (torch) on/off toggle
 *   • Review round so far (opens the scorecard/editor)
 *   • Delete last shot on the current hole (+ restore it)
 *   • Replay the clicker tutorial
 */
import { useRef, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Flashlight, FlashlightOff, ListVideo, Trash2, GraduationCap, Undo2 } from 'lucide-react-native';
import { theme } from '@/constants/theme';

interface RecordingSettingsSheetProps {
  visible: boolean;
  onDismiss: () => void;
  lightEnabled: boolean;
  onToggleLight: (next: boolean) => void;
  onReviewRound: () => void;
  onDeleteLastShot: () => void;
  canDeleteLastShot: boolean;
  /** The hole the delete action would act on — shown in the label. */
  currentHole: number;
  onUndoDelete: () => void;
  /** Deleted shots still restorable this round. */
  undoableDeleteCount: number;
  /** Hole the most recently deleted shot came from. */
  lastDeletedHole: number | null;
  onReplayTutorial: () => void;
}

export function RecordingSettingsSheet({
  visible,
  onDismiss,
  lightEnabled,
  onToggleLight,
  onReviewRound,
  onDeleteLastShot,
  canDeleteLastShot,
  currentHole,
  onUndoDelete,
  undoableDeleteCount,
  lastDeletedHole,
  onReplayTutorial,
}: RecordingSettingsSheetProps) {
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (visible) sheetRef.current?.snapToIndex(0);
    else sheetRef.current?.close();
  }, [visible]);

  if (!visible) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={['62%']}
      enablePanDownToClose
      onClose={onDismiss}
      backgroundStyle={{ backgroundColor: theme.colors.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ padding: 20, paddingBottom: 36 }}>
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 18,
            fontWeight: '700',
            textAlign: 'center',
            marginBottom: 18,
          }}
        >
          Recording options
        </Text>

        {/* Recording light toggle */}
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            onToggleLight(!lightEnabled);
          }}
          style={rowStyle}
        >
          {lightEnabled ? (
            <Flashlight size={20} color={theme.colors.accentGold ?? theme.colors.primary} />
          ) : (
            <FlashlightOff size={20} color={theme.colors.textTertiary} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={rowTitle}>Recording light</Text>
            <Text style={rowSub}>
              Phone torch turns on while recording so the golfer can see it's live.
            </Text>
          </View>
          {/* Track / thumb toggle */}
          <View
            style={{
              width: 46,
              height: 28,
              borderRadius: 14,
              padding: 3,
              backgroundColor: lightEnabled
                ? theme.colors.primary
                : theme.colors.surfaceBorder,
              alignItems: lightEnabled ? 'flex-end' : 'flex-start',
            }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: '#fff',
              }}
            />
          </View>
        </Pressable>

        {/* Review round so far */}
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onReviewRound();
          }}
          style={rowStyle}
        >
          <ListVideo size={20} color={theme.colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={rowTitle}>Review round so far</Text>
            <Text style={rowSub}>See your clips grouped by hole. Reorder or fix holes.</Text>
          </View>
        </Pressable>

        {/* Replay clicker tutorial */}
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onReplayTutorial();
          }}
          style={rowStyle}
        >
          <GraduationCap size={20} color={theme.colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text style={rowTitle}>Replay clicker tutorial</Text>
            <Text style={rowSub}>Run through the click controls again.</Text>
          </View>
        </Pressable>

        {/* Undo delete — only shown once something has been deleted */}
        {undoableDeleteCount > 0 && (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onUndoDelete();
            }}
            style={rowStyle}
          >
            <Undo2 size={20} color={theme.colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={[rowTitle, { color: theme.colors.primary }]}>
                Restore deleted shot
              </Text>
              <Text style={rowSub}>
                {lastDeletedHole !== null
                  ? `Put the last shot you deleted back on hole ${lastDeletedHole}.`
                  : 'Put the last shot you deleted back.'}
                {undoableDeleteCount > 1 ? ` (${undoableDeleteCount} available)` : ''}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Delete last shot on the CURRENT hole — destructive.
            The hole number is in the label because the action is scoped to
            whichever hole you're standing on: step back to hole 3 and it
            deletes hole 3's last shot, not the round's last shot. */}
        <Pressable
          onPress={() => {
            if (!canDeleteLastShot) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onDeleteLastShot();
          }}
          disabled={!canDeleteLastShot}
          style={[rowStyle, { opacity: canDeleteLastShot ? 1 : 0.4 }]}
        >
          <Trash2 size={20} color={theme.colors.accentRed} />
          <View style={{ flex: 1 }}>
            <Text style={[rowTitle, { color: theme.colors.accentRed }]}>
              Delete last shot on hole {currentHole}
            </Text>
            <Text style={rowSub}>
              {canDeleteLastShot
                ? `Removes hole ${currentHole}'s most recent clip only. You can restore it.`
                : `No clips recorded on hole ${currentHole} yet.`}
            </Text>
          </View>
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}

const rowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 14,
  paddingVertical: 14,
  paddingHorizontal: 14,
  borderRadius: theme.radius.md,
  backgroundColor: theme.colors.surfaceElevated,
  borderWidth: 1,
  borderColor: theme.colors.surfaceBorder,
  marginBottom: 10,
};

const rowTitle = {
  color: theme.colors.textPrimary,
  fontSize: 15,
  fontWeight: '600' as const,
};

const rowSub = {
  color: theme.colors.textTertiary,
  fontSize: 12,
  marginTop: 2,
};
