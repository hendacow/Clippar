import { ScrollView, Pressable, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';

export type FilterOption = 'all' | 'birdies' | 'eagles' | 'best' | 'month';

interface FilterChipsProps {
  selected: FilterOption;
  onSelect: (filter: FilterOption) => void;
}

export const FILTERS: { key: FilterOption; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'birdies', label: 'Birdies' },
  { key: 'eagles', label: 'Eagles' },
  { key: 'best', label: 'Best Rounds' },
  { key: 'month', label: 'This Month' },
];

export function FilterChips({ selected, onSelect }: FilterChipsProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 16,
        gap: 8,
        paddingVertical: 4,
      }}
      style={{ marginBottom: 16 }}
    >
      {FILTERS.map((filter) => {
        const isActive = selected === filter.key;
        return (
          <Pressable
            key={filter.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(filter.key);
            }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: theme.radius.full,
              backgroundColor: isActive
                ? theme.colors.primary
                : theme.colors.surface,
              borderWidth: 1,
              borderColor: isActive
                ? theme.colors.primary
                : theme.colors.surfaceBorder,
            }}
          >
            <Text
              style={{
                color: isActive ? '#FFFFFF' : theme.colors.textSecondary,
                fontSize: 13,
                fontWeight: '600',
              }}
            >
              {filter.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
