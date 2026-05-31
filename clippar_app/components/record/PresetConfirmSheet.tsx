/**
 * PresetConfirmSheet — bottom sheet shown when a user taps one of their
 * saved presets in the Preset Picker. Confirms the round's setup and
 * lets the user override the starting hole before committing.
 *
 * Design contract (Wave 3 Phase D-redo):
 *   - Preset payload includes course, holes_played, start_hole.
 *   - User can change start_hole inline before confirming.
 *     - For 9-hole rounds, choices are 1 (front 9) or 10 (back 9).
 *     - For 18-hole rounds, only 1 is valid (18 holes from 10 doesn't
 *       fit a standard course), so the selector is hidden.
 *   - course_name and holes_played are displayed but NOT editable here.
 *     If the user wants to change them, they should tap "Set up new" on
 *     the picker instead.
 *   - The CTA label is configurable so the same sheet works for both
 *     Live ("Start round") and Import ("Continue") flows.
 */
import { useRef, useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Flag } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import type { CoursePreset } from '@/types/preset';

export interface PresetConfirmSheetProps {
  /** When non-null the sheet is open. When null it's closed. */
  preset: CoursePreset | null;
  /** Fired when user taps the primary CTA. The override carries the
   *  start hole the user chose — may match the preset's original
   *  value or be the other valid option. */
  onConfirm: (overrides: { startHole: 1 | 10 }) => void;
  /** Fired when the sheet dismisses (swipe-down, tap outside). */
  onCancel: () => void;
  /** Primary CTA label. Use "Start round" for Live, "Continue" for
   *  Import (since Import still has steps after this). */
  ctaLabel: string;
}

export function PresetConfirmSheet({
  preset,
  onConfirm,
  onCancel,
  ctaLabel,
}: PresetConfirmSheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);

  // Local editable copy of the start hole. Resets whenever a new preset
  // is opened so we don't leak the previous preset's chosen hole.
  const [startHole, setStartHole] = useState<1 | 10>(1);

  useEffect(() => {
    if (preset) {
      setStartHole(preset.start_hole);
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [preset]);

  const handleConfirm = () => {
    if (!preset) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onConfirm({ startHole });
  };

  if (!preset) return null;

  // 9-hole rounds are the only case where the user has a real choice
  // between front 9 and back 9. 18-hole always starts at 1 so we hide
  // the selector to avoid offering an invalid option.
  const showStartHoleSelector = preset.holes_played === 9;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={0}
      snapPoints={[showStartHoleSelector ? '45%' : '36%']}
      enablePanDownToClose
      onClose={onCancel}
      backgroundStyle={{ backgroundColor: theme.colors.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ padding: 20 }}>
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 20,
            fontWeight: '700',
            marginBottom: 4,
          }}
        >
          {preset.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 24 }}>
          <Flag size={14} color={theme.colors.textTertiary} />
          <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>
            {preset.course_name} · {preset.holes_played} holes
          </Text>
        </View>

        {showStartHoleSelector && (
          <View style={{ marginBottom: 24 }}>
            <Text
              style={{
                ...theme.typography.bodySmall,
                color: theme.colors.textSecondary,
                fontWeight: '600',
                marginBottom: 8,
              }}
            >
              Starting hole
            </Text>
            <Segmented
              value={String(startHole)}
              options={[
                { value: '1', label: 'Front 9 (1–9)' },
                { value: '10', label: 'Back 9 (10–18)' },
              ]}
              onChange={(v) => {
                Haptics.selectionAsync();
                setStartHole(v === '10' ? 10 : 1);
              }}
            />
          </View>
        )}

        <Button title={ctaLabel} onPress={handleConfirm} />

        <Pressable
          onPress={onCancel}
          style={{ alignItems: 'center', paddingTop: 14, paddingBottom: 4 }}
        >
          <Text
            style={{
              color: theme.colors.textTertiary,
              fontSize: 14,
              fontWeight: '600',
            }}
          >
            Cancel
          </Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}
