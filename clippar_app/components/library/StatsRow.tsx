import { View, Text, ScrollView } from 'react-native';
import { theme } from '@/constants/theme';

interface StatItemProps {
  value: string | number;
  label: string;
  color?: string;
}

function StatItem({ value, label, color = theme.colors.textPrimary }: StatItemProps) {
  return (
    <View
      style={{
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        minWidth: 80,
      }}
    >
      <Text style={{ fontSize: 22, fontWeight: '800', color, letterSpacing: -0.5 }}>
        {value}
      </Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: theme.colors.textTertiary,
          marginTop: 2,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

interface StatsRowProps {
  stats: {
    roundsPlayed: number;
    bestScore: number;
    avgScore: number;
    totalBirdies: number;
    totalEagles: number;
    avgPutts: number;
  };
}

export function StatsRow({ stats }: StatsRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 16,
        gap: 8,
      }}
      style={{ marginBottom: 24 }}
    >
      <StatItem value={stats.bestScore} label="Best" color={theme.colors.birdie} />
      <StatItem value={stats.roundsPlayed} label="Rounds" />
      <StatItem value={stats.avgScore.toFixed(1)} label="Average" />
      <StatItem value={stats.totalBirdies} label="Birdies" color={theme.colors.primary} />
      <StatItem value={stats.totalEagles} label="Eagles" color={theme.colors.accentGold} />
      <StatItem value={stats.avgPutts.toFixed(1)} label="Avg Putts" />
    </ScrollView>
  );
}
