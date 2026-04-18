import { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Dimensions,
  StyleSheet,
} from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Trophy, Target, Flag, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import type {
  CategoryBreakdown,
  StatCategoryKey,
  TrendPoint,
} from '@/hooks/useStatsFilter';

// ---------------------------------------------------------------------------
// Types & category config
// ---------------------------------------------------------------------------

interface CategoryDef {
  key: StatCategoryKey;
  label: string;
  gradient: [string, string];
  accent: string;
  Icon: typeof Trophy;
}

const CATEGORY_DEFS: CategoryDef[] = [
  {
    key: 'eagle',
    label: 'Eagles',
    gradient: ['rgba(255, 215, 0, 0.22)', 'rgba(255, 215, 0, 0.02)'],
    accent: theme.colors.eagle,
    Icon: Trophy,
  },
  {
    key: 'birdie',
    label: 'Birdies',
    gradient: ['rgba(76, 175, 80, 0.22)', 'rgba(76, 175, 80, 0.02)'],
    accent: theme.colors.birdie,
    Icon: TrendingDown,
  },
  {
    key: 'par',
    label: 'Pars',
    gradient: ['rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.01)'],
    accent: theme.colors.par,
    Icon: Target,
  },
  {
    key: 'bogey',
    label: 'Bogeys',
    gradient: ['rgba(255, 152, 0, 0.22)', 'rgba(255, 152, 0, 0.02)'],
    accent: theme.colors.bogey,
    Icon: TrendingUp,
  },
  {
    key: 'double',
    label: 'Doubles',
    gradient: ['rgba(255, 68, 68, 0.22)', 'rgba(255, 68, 68, 0.02)'],
    accent: theme.colors.doubleBogey,
    Icon: AlertTriangle,
  },
  {
    key: 'triple',
    label: 'Triples+',
    gradient: ['rgba(180, 40, 40, 0.28)', 'rgba(180, 40, 40, 0.02)'],
    accent: '#C53030',
    Icon: Flag,
  },
];

// ---------------------------------------------------------------------------
// Single tile
// ---------------------------------------------------------------------------

interface StatTileProps {
  def: CategoryDef;
  count: number;
  active: boolean;
  onPress: () => void;
}

function StatTile({ def, count, active, onPress }: StatTileProps) {
  const { Icon } = def;
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={[
        styles.tile,
        active && { borderColor: def.accent, borderWidth: 1.5 },
      ]}
    >
      <LinearGradient
        colors={def.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.tileIconRow}>
        <View
          style={[
            styles.tileIconBubble,
            { backgroundColor: `${def.accent}20` },
          ]}
        >
          <Icon size={12} color={def.accent} />
        </View>
      </View>
      <Text style={[styles.tileNumber, { color: def.accent }]}>{count}</Text>
      <Text style={styles.tileLabel}>{def.label.toUpperCase()}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Trend chart (React Native SVG)
// ---------------------------------------------------------------------------

interface TrendChartProps {
  data: TrendPoint[];
  width: number;
  height: number;
}

function TrendChart({ data, width, height }: TrendChartProps) {
  if (data.length === 0) {
    return (
      <View
        style={[
          styles.chartEmpty,
          { width, height, borderRadius: theme.radius.md },
        ]}
      >
        <Text style={styles.chartEmptyText}>No rounds in this range</Text>
      </View>
    );
  }

  const padding = { top: 16, right: 16, bottom: 24, left: 32 };
  const innerW = Math.max(1, width - padding.left - padding.right);
  const innerH = Math.max(1, height - padding.top - padding.bottom);

  const values = data.map((d) => d.scoreToPar);
  const minV = Math.min(...values, 0);
  const maxV = Math.max(...values, 0);
  // Pad vertically so the line isn't glued to the edges.
  const rangeMin = minV - 1;
  const rangeMax = maxV + 1;
  const range = Math.max(1, rangeMax - rangeMin);

  const pointFor = (i: number, v: number) => {
    const x =
      padding.left + (data.length <= 1 ? innerW / 2 : (innerW * i) / (data.length - 1));
    const y = padding.top + innerH * (1 - (v - rangeMin) / range);
    return { x, y };
  };

  const linePoints = data
    .map((d, i) => {
      const p = pointFor(i, d.scoreToPar);
      return `${p.x},${p.y}`;
    })
    .join(' ');

  const zeroY = padding.top + innerH * (1 - (0 - rangeMin) / range);

  return (
    <Svg width={width} height={height}>
      {/* Zero / par reference line */}
      <Line
        x1={padding.left}
        x2={padding.left + innerW}
        y1={zeroY}
        y2={zeroY}
        stroke={theme.colors.surfaceBorder}
        strokeDasharray="4 4"
        strokeWidth={1}
      />
      {/* Par label */}
      <SvgText
        x={padding.left - 6}
        y={zeroY + 3}
        fontSize={9}
        fill={theme.colors.textTertiary}
        textAnchor="end"
      >
        E
      </SvgText>

      {/* Trend line */}
      {data.length > 1 && (
        <Polyline
          points={linePoints}
          fill="none"
          stroke={theme.colors.primary}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* Dots */}
      {data.map((d, i) => {
        const p = pointFor(i, d.scoreToPar);
        const isLast = i === data.length - 1;
        return (
          <Circle
            key={`${d.roundId}-${i}`}
            cx={p.x}
            cy={p.y}
            r={isLast ? 4.5 : 2.5}
            fill={isLast ? theme.colors.primary : theme.colors.surfaceElevated}
            stroke={theme.colors.primary}
            strokeWidth={isLast ? 2 : 1.5}
          />
        );
      })}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Main hero
// ---------------------------------------------------------------------------

interface StatsHeroProps {
  breakdown: CategoryBreakdown[];
  trend: TrendPoint[];
  activeCategory: StatCategoryKey | null;
  onSelectCategory: (key: StatCategoryKey | null) => void;
  totalRounds: number;
  avgScoreToPar: number | null;
}

export function StatsHero({
  breakdown,
  trend,
  activeCategory,
  onSelectCategory,
  totalRounds,
  avgScoreToPar,
}: StatsHeroProps) {
  const screenW = Dimensions.get('window').width;
  const chartW = screenW - 32; // 16 side padding each
  const chartH = 120;

  const scoringBreakdown = useMemo(() => {
    const map = new Map(breakdown.map((b) => [b.key, b.count]));
    return CATEGORY_DEFS.map((def) => ({
      def,
      count: map.get(def.key) ?? 0,
    }));
  }, [breakdown]);

  const avgLabel =
    avgScoreToPar == null
      ? '—'
      : avgScoreToPar === 0
        ? 'E'
        : avgScoreToPar > 0
          ? `+${avgScoreToPar.toFixed(1)}`
          : avgScoreToPar.toFixed(1);

  return (
    <View style={styles.container}>
      {/* ---- Summary row ---- */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryValue}>{totalRounds}</Text>
          <Text style={styles.summaryLabel}>ROUNDS</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryBlock}>
          <Text
            style={[
              styles.summaryValue,
              {
                color:
                  avgScoreToPar == null
                    ? theme.colors.textPrimary
                    : avgScoreToPar < 0
                      ? theme.colors.birdie
                      : avgScoreToPar === 0
                        ? theme.colors.textPrimary
                        : avgScoreToPar <= 4
                          ? theme.colors.bogey
                          : theme.colors.doubleBogey,
              },
            ]}
          >
            {avgLabel}
          </Text>
          <Text style={styles.summaryLabel}>AVG TO PAR</Text>
        </View>
      </View>

      {/* ---- Trend chart (above tiles per design spec) ---- */}
      <View style={styles.chartCard}>
        <View style={styles.chartHeader}>
          <Text style={styles.chartTitle}>Score Trend</Text>
          <Text style={styles.chartSub}>Score to par over time</Text>
        </View>
        <TrendChart data={trend} width={chartW - 24} height={chartH} />
      </View>

      {/* ---- Stat tiles (below chart per design spec) ---- */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tilesContent}
        style={styles.tilesScroll}
      >
        {scoringBreakdown.map(({ def, count }) => (
          <StatTile
            key={def.key}
            def={def}
            count={count}
            active={activeCategory === def.key}
            onPress={() =>
              onSelectCategory(activeCategory === def.key ? null : def.key)
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ---- Styles ----

const TILE_WIDTH = 104;

const styles = StyleSheet.create({
  container: {
    marginBottom: 24,
  },
  // Summary
  summaryRow: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  summaryBlock: {
    flex: 1,
    alignItems: 'center',
  },
  summaryValue: {
    fontSize: 28,
    fontWeight: '900',
    color: theme.colors.textPrimary,
    letterSpacing: -0.6,
  },
  summaryLabel: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '700',
    color: theme.colors.textTertiary,
    letterSpacing: 1,
  },
  summaryDivider: {
    width: 1,
    height: 36,
    backgroundColor: theme.colors.surfaceBorder,
    marginHorizontal: 8,
  },

  // Tiles
  tilesScroll: {
    marginBottom: 16,
  },
  tilesContent: {
    paddingHorizontal: 16,
    gap: 10,
  },
  tile: {
    width: TILE_WIDTH,
    height: 108,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    overflow: 'hidden',
    justifyContent: 'space-between',
  },
  tileIconRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  tileIconBubble: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileNumber: {
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1,
    lineHeight: 40,
  },
  tileLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: theme.colors.textTertiary,
  },

  // Chart
  chartCard: {
    marginHorizontal: 16,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  chartTitle: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  chartSub: {
    color: theme.colors.textTertiary,
    fontSize: 11,
    fontWeight: '500',
  },
  chartEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  chartEmptyText: {
    color: theme.colors.textTertiary,
    fontSize: 12,
  },
});
