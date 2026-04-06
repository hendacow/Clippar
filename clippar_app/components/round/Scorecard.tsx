import { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { theme } from '@/constants/theme';
import { getScores, getCourseHoles } from '@/lib/api';

interface Score {
  hole_number: number;
  strokes: number;
  par?: number;
  score_to_par?: number;
}

interface HoleInfo {
  hole_number: number;
  par: number;
}

interface ScorecardProps {
  roundId: string;
  courseId?: string | null;
  holesPlayed?: number;
}

const CELL_WIDTH = 44;
const LABEL_WIDTH = 52;

function getScoreColor(diff: number): string {
  if (diff <= -2) return theme.colors.eagle;
  if (diff === -1) return theme.colors.birdie;
  if (diff === 0) return theme.colors.par;
  if (diff === 1) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

function getScoreBg(diff: number): string {
  if (diff <= -2) return 'rgba(255, 215, 0, 0.15)';
  if (diff === -1) return 'rgba(76, 175, 80, 0.15)';
  if (diff === 0) return 'transparent';
  if (diff === 1) return 'rgba(255, 152, 0, 0.15)';
  return 'rgba(255, 68, 68, 0.15)';
}

function formatDiff(diff: number): string {
  if (diff === 0) return 'E';
  if (diff > 0) return `+${diff}`;
  return `${diff}`;
}

export function Scorecard({ roundId, courseId, holesPlayed = 18 }: ScorecardProps) {
  const [scores, setScores] = useState<Score[]>([]);
  const [holes, setHoles] = useState<HoleInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [scoreData, holeData] = await Promise.all([
          getScores(roundId),
          courseId ? getCourseHoles(courseId) : Promise.resolve([]),
        ]);

        // Build a par lookup from course holes
        const parMap = new Map<number, number>();
        (holeData as HoleInfo[]).forEach((h) => parMap.set(h.hole_number, h.par));

        // Merge par into scores
        const merged: Score[] = (scoreData as Score[]).map((s) => ({
          ...s,
          par: s.par ?? parMap.get(s.hole_number) ?? 4,
          score_to_par:
            s.score_to_par ??
            (s.strokes - (s.par ?? parMap.get(s.hole_number) ?? 4)),
        }));

        setScores(merged);

        // If we have course holes but no scores, still show par row
        if (merged.length === 0 && holeData.length > 0) {
          setHoles(holeData as HoleInfo[]);
        }
      } catch {
        // non-critical
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [roundId, courseId]);

  if (loading) {
    return (
      <View
        style={{
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          padding: theme.spacing.md,
          alignItems: 'center',
          justifyContent: 'center',
          height: 120,
        }}
      >
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (scores.length === 0 && holes.length === 0) {
    return null; // No scorecard data available
  }

  // Use scores if available, otherwise use holes for structure
  const holeNumbers =
    scores.length > 0
      ? scores.map((s) => s.hole_number)
      : holes.map((h) => h.hole_number);

  const totalPar = scores.reduce((sum, s) => sum + (s.par ?? 4), 0);
  const totalStrokes = scores.reduce((sum, s) => sum + s.strokes, 0);
  const totalDiff = totalStrokes - totalPar;

  // Split into front 9 / back 9 for the summary
  const front9 = scores.filter((s) => s.hole_number <= 9);
  const back9 = scores.filter((s) => s.hole_number > 9);
  const front9Score = front9.reduce((sum, s) => sum + s.strokes, 0);
  const back9Score = back9.reduce((sum, s) => sum + s.strokes, 0);

  const cellStyle = {
    width: CELL_WIDTH,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingVertical: 6,
  };

  const labelStyle = {
    width: LABEL_WIDTH,
    paddingHorizontal: 8,
    justifyContent: 'center' as const,
    paddingVertical: 6,
  };

  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  };

  const separatorStyle = {
    height: 1,
    backgroundColor: theme.colors.surfaceBorder,
  };

  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        overflow: 'hidden',
        ...theme.shadows.card,
      }}
    >
      {/* Title */}
      <View
        style={{
          paddingHorizontal: theme.spacing.md,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.sm,
        }}
      >
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontWeight: '700',
            fontSize: 16,
          }}
        >
          Scorecard
        </Text>
      </View>

      {/* Scrollable grid */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ paddingBottom: 2 }}
      >
        <View>
          {/* Hole number row */}
          <View style={rowStyle}>
            <View style={labelStyle}>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 11,
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Hole
              </Text>
            </View>
            {holeNumbers.map((num) => (
              <View key={`hole-${num}`} style={cellStyle}>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 12,
                    fontWeight: '700',
                  }}
                >
                  {num}
                </Text>
              </View>
            ))}
          </View>

          <View style={separatorStyle} />

          {/* Par row */}
          <View style={rowStyle}>
            <View style={labelStyle}>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 11,
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Par
              </Text>
            </View>
            {holeNumbers.map((num) => {
              const score = scores.find((s) => s.hole_number === num);
              const hole = holes.find((h) => h.hole_number === num);
              const par = score?.par ?? hole?.par ?? 4;
              return (
                <View key={`par-${num}`} style={cellStyle}>
                  <Text
                    style={{
                      color: theme.colors.textSecondary,
                      fontSize: 13,
                      fontWeight: '500',
                    }}
                  >
                    {par}
                  </Text>
                </View>
              );
            })}
          </View>

          <View style={separatorStyle} />

          {/* Score row */}
          {scores.length > 0 && (
            <>
              <View style={rowStyle}>
                <View style={labelStyle}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Score
                  </Text>
                </View>
                {holeNumbers.map((num) => {
                  const score = scores.find((s) => s.hole_number === num);
                  const diff = score?.score_to_par ?? 0;
                  return (
                    <View
                      key={`score-${num}`}
                      style={{
                        ...cellStyle,
                        backgroundColor: score ? getScoreBg(diff) : 'transparent',
                      }}
                    >
                      <Text
                        style={{
                          color: score ? getScoreColor(diff) : theme.colors.textTertiary,
                          fontSize: 15,
                          fontWeight: '800',
                        }}
                      >
                        {score?.strokes ?? '-'}
                      </Text>
                    </View>
                  );
                })}
              </View>

              <View style={separatorStyle} />

              {/* +/- row */}
              <View style={rowStyle}>
                <View style={labelStyle}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    +/-
                  </Text>
                </View>
                {holeNumbers.map((num) => {
                  const score = scores.find((s) => s.hole_number === num);
                  const diff = score?.score_to_par ?? 0;
                  return (
                    <View key={`diff-${num}`} style={cellStyle}>
                      <Text
                        style={{
                          color: score ? getScoreColor(diff) : theme.colors.textTertiary,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        {score ? formatDiff(diff) : '-'}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {/* Totals summary */}
      {scores.length > 0 && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-around',
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
            paddingVertical: 10,
            paddingHorizontal: theme.spacing.md,
          }}
        >
          {back9.length > 0 && (
            <>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ color: theme.colors.textTertiary, fontSize: 10, fontWeight: '600' }}>
                  OUT
                </Text>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 16 }}>
                  {front9Score || '-'}
                </Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ color: theme.colors.textTertiary, fontSize: 10, fontWeight: '600' }}>
                  IN
                </Text>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 16 }}>
                  {back9Score || '-'}
                </Text>
              </View>
            </>
          )}
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 10, fontWeight: '600' }}>
              TOTAL
            </Text>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 16 }}>
              {totalStrokes}
            </Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 10, fontWeight: '600' }}>
              PAR
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontWeight: '700', fontSize: 16 }}>
              {totalPar}
            </Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: theme.colors.textTertiary, fontSize: 10, fontWeight: '600' }}>
              +/-
            </Text>
            <Text
              style={{
                fontWeight: '700',
                fontSize: 16,
                color: getScoreColor(totalDiff),
              }}
            >
              {formatDiff(totalDiff)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
