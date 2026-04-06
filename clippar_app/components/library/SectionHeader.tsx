import { View, Text, Pressable } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { theme } from '@/constants/theme';

interface SectionHeaderProps {
  title: string;
  onSeeAll?: () => void;
}

export function SectionHeader({ title, onSeeAll }: SectionHeaderProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        marginBottom: 12,
      }}
    >
      <Text
        style={{
          color: theme.colors.textPrimary,
          fontSize: 18,
          fontWeight: '700',
          letterSpacing: -0.2,
        }}
      >
        {title}
      </Text>
      {onSeeAll && (
        <Pressable
          onPress={onSeeAll}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
          hitSlop={8}
        >
          <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '600' }}>
            See All
          </Text>
          <ChevronRight size={16} color={theme.colors.primary} />
        </Pressable>
      )}
    </View>
  );
}
