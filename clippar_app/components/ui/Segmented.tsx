import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';

export type SegmentedOption = { value: string; label: string };

export interface SegmentedProps {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
}

// Compact 2- to 4-option toggle. Used for the round setup (9/18, Front/Back)
// and any future tab-like binary choice. Fires a light haptic on change so
// the user gets the same physical feedback they'd get from a native iOS
// segmented control without dragging in a separate native module.
export function Segmented({ value, options, onChange }: SegmentedProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        padding: 4,
        gap: 4,
      }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => {
              if (selected) return;
              Haptics.selectionAsync();
              onChange(opt.value);
            }}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: selected ? theme.colors.accent : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: selected ? '#000' : theme.colors.textSecondary,
                fontSize: 15,
                fontWeight: selected ? '700' : '500',
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
