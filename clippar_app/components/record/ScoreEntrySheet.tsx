import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Minus, Plus } from 'lucide-react-native';
import { theme } from '@/constants/theme';

interface ScoreEntrySheetProps {
  visible: boolean;
  holeNumber: number;
  par: number;
  autoStrokes: number; // pre-filled from clip count
  onConfirm: (strokes: number, putts: number) => void;
  onDismiss: () => void;
}

export function ScoreEntrySheet({
  visible,
  holeNumber,
  par,
  autoStrokes,
  onConfirm,
  onDismiss,
}: ScoreEntrySheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const [strokes, setStrokes] = useState(autoStrokes);
  const [putts, setPutts] = useState(2);
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to the live confirm handler so the auto-dismiss timer always reads
  // the latest strokes/putts values, not a stale closure from first render.
  const handleConfirmRef = useRef<() => void>(() => {});

  const handleConfirm = useCallback(() => {
    if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    onConfirm(strokes, putts);
  }, [strokes, putts, onConfirm]);

  // Keep the ref in sync with the latest handler every render.
  useEffect(() => {
    handleConfirmRef.current = handleConfirm;
  }, [handleConfirm]);

  const resetAutoDismiss = useCallback(() => {
    if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    autoDismissTimer.current = setTimeout(() => {
      handleConfirmRef.current();
    }, 5000);
  }, []);

  // Reset when sheet opens with new data
  useEffect(() => {
    if (visible) {
      setStrokes(autoStrokes);
      setPutts(2);
      bottomSheetRef.current?.snapToIndex(0);
      resetAutoDismiss();
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible, autoStrokes, resetAutoDismiss]);

  useEffect(() => {
    return () => {
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    };
  }, []);

  const adjustStrokes = (delta: number) => {
    Haptics.selectionAsync();
    setStrokes((s) => Math.max(1, s + delta));
    resetAutoDismiss();
  };

  const adjustPutts = (delta: number) => {
    Haptics.selectionAsync();
    setPutts((p) => Math.max(0, p + delta));
    resetAutoDismiss();
  };

  const scoreToPar = strokes - par;
  const scoreColor =
    scoreToPar < 0
      ? theme.colors.birdie
      : scoreToPar === 0
        ? theme.colors.par
        : scoreToPar <= 1
          ? theme.colors.bogey
          : theme.colors.doubleBogey;

  if (!visible) return null;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={0}
      snapPoints={['42%']}
      enablePanDownToClose
      onClose={onDismiss}
      backgroundStyle={{ backgroundColor: theme.colors.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ padding: 20 }}>
        {/* Header */}
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 18,
            fontWeight: '700',
            textAlign: 'center',
            marginBottom: 4,
          }}
        >
          Hole {holeNumber} — Par {par}
        </Text>
        <Text
          style={{
            color: scoreColor,
            fontSize: 14,
            fontWeight: '600',
            textAlign: 'center',
            marginBottom: 20,
          }}
        >
          {scoreToPar === 0 ? 'Even' : scoreToPar > 0 ? `+${scoreToPar}` : scoreToPar}
        </Text>

        {/* Strokes */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <Text style={{ color: theme.colors.textSecondary, fontSize: 15, fontWeight: '500' }}>
            Strokes
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Pressable
              onPress={() => adjustStrokes(-1)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Minus size={18} color={theme.colors.textPrimary} />
            </Pressable>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 28, fontWeight: '800', width: 40, textAlign: 'center' }}>
              {strokes}
            </Text>
            <Pressable
              onPress={() => adjustStrokes(1)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Plus size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </View>
        </View>

        {/* Putts */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
          }}
        >
          <Text style={{ color: theme.colors.textSecondary, fontSize: 15, fontWeight: '500' }}>
            Putts
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Pressable
              onPress={() => adjustPutts(-1)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Minus size={18} color={theme.colors.textPrimary} />
            </Pressable>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 28, fontWeight: '800', width: 40, textAlign: 'center' }}>
              {putts}
            </Text>
            <Pressable
              onPress={() => adjustPutts(1)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Plus size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </View>
        </View>

        {/* Confirm */}
        <Pressable
          onPress={handleConfirm}
          style={{
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radius.full,
            paddingVertical: 14,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>
            Confirm & Next Hole
          </Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}
