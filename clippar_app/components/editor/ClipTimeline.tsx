import { View, Text, ScrollView, Pressable } from 'react-native';
import { Film } from 'lucide-react-native';
import { theme } from '@/constants/theme';

interface ClipItem {
  id: string;
  holeNumber: number;
  shotNumber: number;
}

interface ClipTimelineProps {
  clips: ClipItem[];
  selectedIndex?: number;
  onSelect?: (index: number) => void;
}

export function ClipTimeline({ clips, selectedIndex, onSelect }: ClipTimelineProps) {
  if (clips.length === 0) {
    return (
      <View
        style={{
          height: 72,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Text style={{ color: theme.colors.textTertiary, fontSize: 13 }}>No clips</Text>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
    >
      {clips.map((clip, i) => {
        const isSelected = selectedIndex === i;
        return (
          <Pressable key={clip.id} onPress={() => onSelect?.(i)}>
            <View
              style={{
                width: 80,
                height: 64,
                backgroundColor: isSelected
                  ? theme.colors.primaryMuted
                  : theme.colors.surface,
                borderRadius: theme.radius.sm,
                borderWidth: 1,
                borderColor: isSelected
                  ? theme.colors.primary
                  : theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Film size={14} color={isSelected ? theme.colors.primary : theme.colors.textTertiary} />
              <Text
                style={{
                  color: isSelected ? theme.colors.primary : theme.colors.textSecondary,
                  fontSize: 11,
                  fontWeight: '600',
                }}
              >
                H{clip.holeNumber} S{clip.shotNumber}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
