/**
 * RecentScorecards — the horizontally scrollable row of courses the golfer has
 * already set up, shown at the top of the Live recording setup screen.
 *
 * Why it exists: a scorecard the user has already entered hole-by-hole is the
 * most expensive thing in this flow, and it was effectively write-only — the
 * full-screen preset picker it used to live on was only reachable on a SECOND
 * entry into Live mode (the presets fetch starts when Live opens, so the list
 * was always empty on the first look). Putting the saved setups on the setup
 * screen itself means they're offered every time.
 *
 * Tapping a card doesn't start anything: the parent takes the user to the
 * "which hole are you starting on" step, the same step the 9/18 selector leads
 * to, so both paths confirm the tee-off hole before a round begins.
 */
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Bookmark } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import type { CoursePreset } from '@/types/preset';
import { presetHasScorecard } from '@/lib/scorecardLogic';

export interface RecentScorecardsProps {
  /** Already ordered + capped by the caller (lib/roundSetup.recentSetups). */
  presets: CoursePreset[];
  /** True while the presets fetch is in flight — shows placeholder cards so
   *  the row doesn't pop in under the user's thumb mid-tap. */
  loading?: boolean;
  onSelect: (preset: CoursePreset) => void;
}

const CARD_WIDTH = 168;

function holesLabel(preset: CoursePreset): string {
  if (preset.holes_played === 18) return '18 holes';
  return preset.start_hole === 10 ? 'Back 9' : 'Front 9';
}

export function RecentScorecards({ presets, loading, onSelect }: RecentScorecardsProps) {
  // Nothing saved and nothing coming — render nothing at all rather than an
  // empty-state card taking up the top of a first-time user's setup screen.
  if (presets.length === 0 && !loading) return null;

  return (
    <View style={{ marginBottom: 20 }}>
      <Text
        style={{
          ...theme.typography.caption,
          color: theme.colors.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        Recent courses
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // Negative margin + matching padding so the row bleeds to the screen
        // edge (a card half off-screen is what tells the user it scrolls)
        // while the first card still lines up with the form below.
        style={{ marginHorizontal: -24 }}
        contentContainerStyle={{ paddingHorizontal: 24, gap: 10 }}
      >
        {presets.length === 0 && loading
          ? [0, 1].map((i) => (
              <View
                key={i}
                style={{
                  width: CARD_WIDTH,
                  height: 84,
                  borderRadius: theme.radius.md,
                  backgroundColor: theme.colors.surfaceElevated,
                  opacity: 0.4,
                }}
              />
            ))
          : presets.map((preset) => (
              <Pressable
                key={preset.id}
                onPress={() => onSelect(preset)}
                accessibilityRole="button"
                accessibilityLabel={`${preset.name}, ${holesLabel(preset)}`}
                style={({ pressed }) => ({
                  width: CARD_WIDTH,
                  padding: 12,
                  borderRadius: theme.radius.md,
                  backgroundColor: pressed
                    ? theme.colors.surface
                    : theme.colors.surfaceElevated,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <Bookmark size={14} color={theme.colors.accent} />
                  <Text
                    style={{ color: theme.colors.textTertiary, fontSize: 11, fontWeight: '700' }}
                  >
                    {holesLabel(preset)}
                  </Text>
                  {/* Same badge as the preset picker: tells the user which of
                      these carry their own pars rather than the API's. */}
                  {presetHasScorecard(preset) && (
                    <View
                      style={{
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        borderRadius: theme.radius.sm,
                        backgroundColor: theme.colors.primaryMuted,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.primaryLight,
                          fontSize: 9,
                          fontWeight: '700',
                          letterSpacing: 0.3,
                        }}
                      >
                        SCORECARD
                      </Text>
                    </View>
                  )}
                </View>
                <Text
                  style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' }}
                  numberOfLines={2}
                >
                  {preset.course_name}
                </Text>
              </Pressable>
            ))}
      </ScrollView>
    </View>
  );
}
