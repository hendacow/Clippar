/**
 * PresetPickerScreen — full-screen step shown between the Record-tab
 * mode chooser (Live / Import card) and the actual setup screen, when
 * the user has one or more saved round presets.
 *
 * Design contract (Wave 3 Phase D-redo):
 *   - Replaces the previous "preset list at top of setup" pattern.
 *   - User sees a list of presets they can tap to start fast, with a
 *     "Set up new round" CTA at the bottom for fresh setup.
 *   - Tapping a preset doesn't immediately commit — the parent opens a
 *     PresetConfirmSheet on top to let the user override the starting
 *     hole and explicitly confirm.
 *   - Used by BOTH record.tsx (Live entry) and import.tsx (Import
 *     entry). The CTA labels stay the same; only the parent-side
 *     handlers differ.
 *
 * If the parent is in a loading state (presets fetching) we briefly
 * show a skeleton list rather than the empty "Set up new" CTA alone —
 * otherwise the user could fly past their saved rounds while the
 * network call resolves.
 */
import { View, Text, Pressable, ScrollView } from 'react-native';
import { ArrowLeft, Bookmark, ChevronRight } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CoursePreset } from '@/types/preset';
import { presetHasScorecard } from '@/lib/scorecardLogic';

export interface PresetPickerScreenProps {
  presets: CoursePreset[];
  loading?: boolean;
  /** Called when the user taps a preset card. The parent should open
   *  a confirmation sheet, not immediately commit. */
  onSelectPreset: (preset: CoursePreset) => void;
  /** Called when the user taps the "Set up new round" CTA at the
   *  bottom. The parent should advance to its setup screen. */
  onSetUpNew: () => void;
  /** Back-button handler. For Live this typically resets the mode
   *  chooser; for Import it navigates back to the chooser. */
  onBack: () => void;
  /** Top-of-screen header label. Examples:
   *  - "Start a round"   (Live)
   *  - "Import a round"  (Import) */
  title: string;
  /** Sub-label under the title. Optional. */
  subtitle?: string;
}

export function PresetPickerScreen({
  presets,
  loading,
  onSelectPreset,
  onSetUpNew,
  onBack,
  title,
  subtitle,
}: PresetPickerScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Pressable onPress={onBack} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 18,
              flex: 1,
            }}
          >
            {title}
          </Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        >
          {subtitle && (
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 14,
                marginBottom: 20,
              }}
            >
              {subtitle}
            </Text>
          )}

          {/* Saved rounds section */}
          {presets.length > 0 && (
            <>
              <Text
                style={{
                  ...theme.typography.caption,
                  color: theme.colors.textTertiary,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Saved rounds
              </Text>
              <View style={{ gap: 8, marginBottom: 24 }}>
                {presets.map((preset) => (
                  <Pressable
                    key={preset.id}
                    onPress={() => onSelectPreset(preset)}
                    hitSlop={4}
                  >
                    <Card
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
                    >
                      <Bookmark size={18} color={theme.colors.accent} />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                          <Text
                            style={{
                              color: theme.colors.textPrimary,
                              fontWeight: '600',
                              fontSize: 15,
                              flexShrink: 1,
                            }}
                            // Allow long course names ("Royal Queensland Golf
                            // Club") a second line instead of truncating to
                            // "Royal Queensland Golf...".
                            numberOfLines={2}
                          >
                            {preset.name}
                          </Text>
                          {/* Badge presets that carry a saved custom scorecard
                              so the user can tell which bookmarks override the
                              (untrusted) API par. */}
                          {presetHasScorecard(preset) && (
                            <View
                              style={{
                                paddingHorizontal: 6,
                                paddingVertical: 2,
                                borderRadius: theme.radius.sm,
                                backgroundColor: theme.colors.primaryMuted,
                              }}
                            >
                              <Text
                                style={{
                                  color: theme.colors.primaryLight,
                                  fontSize: 10,
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
                          style={{
                            color: theme.colors.textSecondary,
                            fontSize: 13,
                            marginTop: 2,
                          }}
                        >
                          {preset.holes_played === 9
                            ? preset.start_hole === 1
                              ? 'Front 9'
                              : 'Back 9'
                            : '18 holes'}
                          {' · '}
                          {preset.course_name}
                        </Text>
                      </View>
                      <ChevronRight size={16} color={theme.colors.textTertiary} />
                    </Card>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {/* Loading skeleton — only shown if we have zero presets cached
              AND the parent says we're loading. Avoids a brief flash of
              "Set up new" alone when the user actually has saved rounds. */}
          {loading && presets.length === 0 && (
            <View style={{ gap: 8, marginBottom: 24 }}>
              {[0, 1].map((i) => (
                <View
                  key={i}
                  style={{
                    height: 64,
                    borderRadius: theme.radius.md,
                    backgroundColor: theme.colors.surfaceElevated,
                    opacity: 0.4,
                  }}
                />
              ))}
            </View>
          )}

          {/* Divider only when we have presets above. When the list is
              empty the "Set up new" sits alone with no need for an OR. */}
          {presets.length > 0 && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginBottom: 16,
                gap: 12,
              }}
            >
              <View
                style={{
                  flex: 1,
                  height: 1,
                  backgroundColor: theme.colors.surfaceBorder,
                }}
              />
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 12,
                  letterSpacing: 0.5,
                }}
              >
                OR
              </Text>
              <View
                style={{
                  flex: 1,
                  height: 1,
                  backgroundColor: theme.colors.surfaceBorder,
                }}
              />
            </View>
          )}

          <Button
            title="Set up new round"
            variant={presets.length > 0 ? 'secondary' : 'primary'}
            onPress={onSetUpNew}
          />
        </ScrollView>
      </View>
    </GradientBackground>
  );
}
