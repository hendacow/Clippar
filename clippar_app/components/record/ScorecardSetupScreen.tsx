/**
 * ScorecardSetupScreen — "Set the scorecard" step in the Live recording
 * setup. After the user has a course name + holes count (9/18) + start hole,
 * this lets them SAVE the course's scorecard by choosing the par of each
 * hole. The saved per-hole par becomes a bookmark that overrides the
 * golf-course API par on future rounds (see lib/scorecardLogic.ts).
 *
 * UX (Henry's spec):
 *   - One active hole at a time, shown big with three large 3 / 4 / 5
 *     buttons. Tapping a par sets this hole and AUTO-ADVANCES to the next
 *     unfilled hole.
 *   - A compact overview grid of every hole with its chosen par. Tapping a
 *     hole re-opens it for editing.
 *   - "Save course scorecard" primary CTA, enabled once every hole is filled.
 *
 * Dark theme + existing record styles; reduced-motion aware (the only motion
 * is a short fade on the active-hole card, skipped under reduce-motion);
 * fits an iPhone SE (the active card is fixed height, the grid scrolls).
 */
import { useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import Animated, {
  useReducedMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { ArrowLeft, Check } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import {
  PAR_OPTIONS,
  liveHoleNumbers,
  nextUnfilledIndex,
  isScorecardComplete,
} from '@/lib/scorecardLogic';

export interface ScorecardSetupScreenProps {
  courseName: string;
  holesPlayed: 9 | 18;
  startHole: 1 | 10;
  /** Disables the CTA + shows a spinner while the preset is being saved. */
  saving?: boolean;
  /**
   * True when the user already has a saved scorecard for this course name, so
   * saving OVERWRITES it (upsert by name) rather than creating a new one. Only
   * changes the CTA copy — the save itself is the same call either way.
   */
  isUpdate?: boolean;
  onBack: () => void;
  /** Positional par array, length = holesPlayed, element i = i-th hole played. */
  onSave: (holePars: number[]) => void;
}

export function ScorecardSetupScreen({
  courseName,
  holesPlayed,
  startHole,
  saving = false,
  isUpdate = false,
  onBack,
  onSave,
}: ScorecardSetupScreenProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  // The real hole numbers this round plays (e.g. back nine → 10..18). The
  // par array is positional; holeNumbers[i] is just the label for slot i.
  const holeNumbers = useMemo(
    () => liveHoleNumbers(holesPlayed, startHole),
    [holesPlayed, startHole],
  );

  // Positional pars, null = not yet chosen. Length is fixed for the life of
  // this screen (holesPlayed can't change here — the user backs out to edit).
  const [pars, setPars] = useState<(number | null)[]>(() =>
    new Array(holesPlayed).fill(null),
  );
  const [activeIndex, setActiveIndex] = useState(0);

  // Fade the active-hole card on hole change for a touch of continuity.
  const fade = useSharedValue(1);
  const cardStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const flashActiveCard = () => {
    if (reduceMotion) return;
    fade.value = 0.4;
    fade.value = withTiming(1, { duration: 140 });
  };

  const complete = isScorecardComplete(pars);
  const filledCount = pars.filter((p) => p != null).length;

  const choosePar = (par: number) => {
    Haptics.selectionAsync();
    setPars((prev) => {
      const next = [...prev];
      next[activeIndex] = par;
      // Auto-advance to the next hole still needing a par (wraps once).
      const advanceTo = nextUnfilledIndex(next, activeIndex);
      if (advanceTo != null) {
        setActiveIndex(advanceTo);
        flashActiveCard();
      }
      return next;
    });
  };

  const openHole = (index: number) => {
    Haptics.selectionAsync();
    setActiveIndex(index);
    flashActiveCard();
  };

  const handleSave = () => {
    if (!complete || saving) return;
    // Every slot is filled (complete === true) so the cast is safe.
    onSave(pars as number[]);
  };

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
          <Pressable onPress={onBack} hitSlop={12} disabled={saving}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text
              style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 18 }}
              numberOfLines={1}
            >
              Set the scorecard
            </Text>
            <Text
              style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 1 }}
              numberOfLines={1}
            >
              {courseName} · {filledCount}/{holesPlayed} holes
            </Text>
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Active hole: big par picker */}
          <Animated.View
            style={[
              cardStyle,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radius.lg,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                padding: 20,
                marginBottom: 20,
              },
            ]}
          >
            <Text
              style={{
                ...theme.typography.caption,
                color: theme.colors.textTertiary,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              Hole
            </Text>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 44,
                fontWeight: '900',
                letterSpacing: -1,
                marginBottom: 16,
              }}
            >
              {holeNumbers[activeIndex]}
            </Text>
            <Text
              style={{
                ...theme.typography.bodySmall,
                color: theme.colors.textSecondary,
                fontWeight: '600',
                marginBottom: 10,
              }}
            >
              Tap this hole's par
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {PAR_OPTIONS.map((par) => {
                const selected = pars[activeIndex] === par;
                return (
                  <Pressable
                    key={par}
                    onPress={() => choosePar(par)}
                    accessibilityRole="button"
                    accessibilityLabel={`Par ${par}`}
                    accessibilityState={{ selected }}
                    style={({ pressed }) => ({
                      flex: 1,
                      aspectRatio: 1,
                      maxHeight: 96,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: theme.radius.md,
                      borderWidth: 2,
                      borderColor: selected
                        ? theme.colors.accent
                        : theme.colors.surfaceBorder,
                      backgroundColor: selected
                        ? theme.colors.accent
                        : pressed
                          ? theme.colors.surface
                          : theme.colors.background,
                    })}
                  >
                    <Text
                      style={{
                        color: selected ? '#000' : theme.colors.textPrimary,
                        fontSize: 36,
                        fontWeight: '900',
                      }}
                    >
                      {par}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Animated.View>

          {/* Overview grid — tap any hole to re-open it */}
          <Text
            style={{
              ...theme.typography.caption,
              color: theme.colors.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 8,
            }}
          >
            All holes
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {holeNumbers.map((holeNum, index) => {
              const par = pars[index];
              const isActive = index === activeIndex;
              return (
                <Pressable
                  key={holeNum}
                  onPress={() => openHole(index)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    par != null
                      ? `Hole ${holeNum}, par ${par}. Tap to change.`
                      : `Hole ${holeNum}, par not set. Tap to set.`
                  }
                  style={{
                    width: 52,
                    paddingVertical: 8,
                    alignItems: 'center',
                    borderRadius: theme.radius.sm,
                    borderWidth: isActive ? 2 : 1,
                    borderColor: isActive
                      ? theme.colors.accent
                      : theme.colors.surfaceBorder,
                    backgroundColor:
                      par != null
                        ? theme.colors.surfaceElevated
                        : theme.colors.surface,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                      fontWeight: '600',
                    }}
                  >
                    {holeNum}
                  </Text>
                  <Text
                    style={{
                      color:
                        par != null
                          ? theme.colors.textPrimary
                          : theme.colors.textTertiary,
                      fontSize: 18,
                      fontWeight: '800',
                      marginTop: 2,
                    }}
                  >
                    {par != null ? par : '–'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* Save CTA pinned to the bottom */}
        <View
          style={{
            padding: 16,
            paddingBottom: Math.max(insets.bottom, 16),
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
          }}
        >
          <Button
            title={
              complete
                ? isUpdate
                  ? 'Update saved scorecard'
                  : 'Save course scorecard'
                : `Set all ${holesPlayed} holes`
            }
            onPress={handleSave}
            loading={saving}
            disabled={!complete}
            icon={
              complete && !saving ? (
                <Check size={18} color="#FFFFFF" />
              ) : undefined
            }
            style={complete ? theme.shadows.glow : undefined}
          />
        </View>
      </View>
    </GradientBackground>
  );
}
