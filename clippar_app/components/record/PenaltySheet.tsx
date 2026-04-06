import { useRef, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { AlertTriangle, XCircle, Droplets, MapPinOff, Flag } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import type { PenaltyType } from '@/types/round';
import { PENALTY_LABELS } from '@/types/round';

interface PenaltySheetProps {
  visible: boolean;
  onSelect: (type: PenaltyType) => void;
  onDismiss: () => void;
}

const PENALTY_OPTIONS: { type: PenaltyType; icon: typeof AlertTriangle; color: string }[] = [
  { type: 'lost_ball', icon: XCircle, color: theme.colors.accentRed },
  { type: 'water_hazard', icon: Droplets, color: '#2196F3' },
  { type: 'out_of_bounds', icon: MapPinOff, color: theme.colors.bogey },
  { type: 'pickup', icon: Flag, color: theme.colors.textSecondary },
];

export function PenaltySheet({ visible, onSelect, onDismiss }: PenaltySheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleSelect = (type: PenaltyType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSelect(type);
  };

  if (!visible) return null;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={0}
      snapPoints={['40%']}
      enablePanDownToClose
      onClose={onDismiss}
      backgroundStyle={{ backgroundColor: theme.colors.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ padding: 20 }}>
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 18,
            fontWeight: '700',
            textAlign: 'center',
            marginBottom: 20,
          }}
        >
          Penalty / Pickup
        </Text>

        {PENALTY_OPTIONS.map(({ type, icon: Icon, color }) => (
          <Pressable
            key={type}
            onPress={() => handleSelect(type)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              marginBottom: 8,
            }}
          >
            <Icon size={20} color={color} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}>
                {PENALTY_LABELS[type]}
              </Text>
              {type === 'pickup' && (
                <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 2 }}>
                  Records as par + 2 and moves to next hole
                </Text>
              )}
            </View>
          </Pressable>
        ))}
      </BottomSheetView>
    </BottomSheet>
  );
}
