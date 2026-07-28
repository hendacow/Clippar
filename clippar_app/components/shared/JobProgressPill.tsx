/**
 * Global job pill — the one piece of chrome that follows the user around the
 * app while a long on-device job runs.
 *
 * Both jobs it reports (reel compose, auto-trim batch) deliberately outlive the
 * screen that started them, so the screen is the wrong place to show them:
 *
 *   - compose  → "Stitching your reel… 62%" (real native percent, or an
 *                indeterminate label while the pre-native prep phase runs).
 *   - trim     → "Trimming clips — 7 of 12" (a count; the batch has no
 *                sub-clip progress and a synthesised percent would be a lie).
 *   - done     → a brief "Reel ready — tap to watch" so a compose that
 *                finished while the user was elsewhere isn't silent. The
 *                screen-level flow still navigates on its own when the user
 *                stayed put; this only covers the backgrounded case.
 *
 * Rules:
 *   - ONE pill, ever. Compose outranks trim (it is the job with a percent and
 *     the one the user is waiting on to share).
 *   - It never appears on the screen that already shows the same job inline —
 *     the editor owns the auto-trim banner and the export sheet, round detail
 *     owns the PROCESSING reel stage. No duplicate progress.
 *   - It never blocks touches: the container is pointerEvents="box-none" and
 *     only the pill itself is hit-testable.
 *   - It disappears on completion, on failure, and on the trim stall backstop —
 *     there is no path that leaves it parked at 99%.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Animated } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Film, Scissors, CircleCheck } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { useUploadContext } from '@/contexts/UploadContext';

/** How long the "Reel ready" confirmation lingers before fading out. */
const DONE_VISIBLE_MS = 6_000;

/**
 * Routes that own the whole screen and must stay uncluttered: the camera (it
 * hides even the tab bar while recording) and the import flow the user is
 * actively filling in. Everywhere else the pill is welcome.
 */
const SUPPRESSED_ROUTES = ['/record', '/round/import'];

export function JobProgressPill() {
  const { compose, trim } = useUploadContext();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  // Transient success state for a compose that finished while the user was on
  // another screen. Cleared by the timer, or immediately if a new job starts.
  const [doneRoundId, setDoneRoundId] = useState<string | null>(null);
  const lastCompletedRef = useRef<string | null>(null);

  useEffect(() => {
    const completed = compose.lastCompletedRoundId;
    if (!completed || completed === lastCompletedRef.current) return;
    lastCompletedRef.current = completed;
    setDoneRoundId(completed);
    const t = setTimeout(() => setDoneRoundId(null), DONE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [compose.lastCompletedRoundId]);

  // A new job always wins over a stale confirmation.
  useEffect(() => {
    if (compose.active || trim.active) setDoneRoundId(null);
  }, [compose.active, trim.active]);

  // ---- Pick the one thing to show ----
  let icon: 'compose' | 'trim' | 'done' | null = null;
  let title = '';
  let detail = '';
  let percent: number | null = null;
  let target: string | null = null;

  const suppressed = SUPPRESSED_ROUTES.includes(pathname);

  if (suppressed) {
    // nothing — see SUPPRESSED_ROUTES
  } else if (compose.active && compose.roundId) {
    // Suppressed on round detail, which renders the full PROCESSING stage.
    if (pathname !== `/round/${compose.roundId}`) {
      icon = 'compose';
      title = compose.percent != null
        ? `Building reel · ${Math.round(compose.percent)}%`
        : 'Building reel';
      detail = compose.stageLabel || 'Working on it…';
      percent = compose.percent;
      target = `/round/${compose.roundId}`;
    }
  } else if (trim.active && trim.roundId && trim.total > 0) {
    // Suppressed in the editor, which renders the auto-trim banner inline.
    if (pathname !== '/round/editor') {
      icon = 'trim';
      title = `Trimming clips · ${trim.completed} of ${trim.total}`;
      detail = trim.courseName ? `${trim.courseName} — this keeps running` : 'This keeps running';
      target = `/round/editor?roundId=${trim.roundId}`;
    }
  } else if (doneRoundId && pathname !== `/round/${doneRoundId}`) {
    icon = 'done';
    title = 'Reel ready';
    detail = 'Tap to watch it';
    target = `/round/${doneRoundId}`;
  }

  const visible = icon !== null;

  // Fade/slide so the pill doesn't pop in mid-scroll.
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  if (!visible) return null;

  const accent = icon === 'done' ? theme.colors.ready : theme.colors.processing;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        // Sits clear of the floating tab pill (68pt + its 8pt bottom padding),
        // which is the lowest chrome any screen puts on top of content.
        bottom: insets.bottom + 84,
        paddingHorizontal: theme.spacing.md,
        alignItems: 'center',
      }}
    >
      <Animated.View
        style={{
          width: '100%',
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        }}
      >
        <Pressable
          onPress={() => {
            if (!target) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push(target as never);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${detail}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingLeft: 12,
            paddingRight: 14,
            paddingVertical: 10,
            borderRadius: theme.radius.full,
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            ...theme.shadows.card,
          }}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: theme.colors.surface,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            {icon === 'done' ? (
              <CircleCheck size={16} color={accent} />
            ) : icon === 'trim' ? (
              <Scissors size={15} color={accent} />
            ) : (
              <Film size={15} color={accent} />
            )}
          </View>

          <View style={{ flex: 1 }}>
            <Text
              style={{
                ...theme.typography.bodySmall,
                fontWeight: '700',
                color: theme.colors.textPrimary,
              }}
              numberOfLines={1}
            >
              {title}
            </Text>
            <Text
              style={{ ...theme.typography.caption, color: theme.colors.textSecondary }}
              numberOfLines={1}
            >
              {detail}
            </Text>
          </View>

          {icon === 'done' ? null : (
            <ActivityIndicator size="small" color={accent} />
          )}
        </Pressable>

        {/* Determinate hairline under the pill — only ever drawn from a real
            native percent, never an invented one. */}
        {percent != null && (
          <View
            style={{
              marginTop: -3,
              marginHorizontal: 16,
              height: 3,
              borderRadius: 2,
              backgroundColor: theme.colors.surfaceBorder,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                height: '100%',
                borderRadius: 2,
                backgroundColor: accent,
                width: `${Math.min(100, Math.max(0, percent))}%`,
              }}
            />
          </View>
        )}
      </Animated.View>
    </View>
  );
}
