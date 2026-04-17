import { useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  Modal,
  StyleSheet,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import {
  useOnboarding,
  TOUR_COPY,
  TOUR_STEPS,
  type TargetRect,
} from '@/contexts/OnboardingContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const CALLOUT_WIDTH = Math.min(320, SCREEN_WIDTH - 32);
const CALLOUT_MARGIN = 16;
const ARROW_SIZE = 12;
const SPOTLIGHT_PADDING = 10;
const SPOTLIGHT_RADIUS = 24;

/**
 * Renders the 4 dark overlay rectangles that AROUND a cutout, leaving a
 * rectangular "hole" where the target element sits.
 * Using 4 overlays avoids needing expo-blur or SVG masks.
 */
function DarkenOverlay({ rect }: { rect: TargetRect | null }) {
  const overlayColor = 'rgba(0,0,0,0.68)';

  if (!rect) {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: overlayColor }]}
      />
    );
  }

  const cutoutX = Math.max(0, rect.x - SPOTLIGHT_PADDING);
  const cutoutY = Math.max(0, rect.y - SPOTLIGHT_PADDING);
  const cutoutW = rect.width + SPOTLIGHT_PADDING * 2;
  const cutoutH = rect.height + SPOTLIGHT_PADDING * 2;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      {/* Top */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: cutoutY,
          backgroundColor: overlayColor,
        }}
      />
      {/* Bottom */}
      <View
        style={{
          position: 'absolute',
          top: cutoutY + cutoutH,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: overlayColor,
        }}
      />
      {/* Left */}
      <View
        style={{
          position: 'absolute',
          top: cutoutY,
          left: 0,
          width: cutoutX,
          height: cutoutH,
          backgroundColor: overlayColor,
        }}
      />
      {/* Right */}
      <View
        style={{
          position: 'absolute',
          top: cutoutY,
          left: cutoutX + cutoutW,
          right: 0,
          height: cutoutH,
          backgroundColor: overlayColor,
        }}
      />
    </View>
  );
}

function SpotlightRing({ rect }: { rect: TargetRect }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.out(Easing.ease) }),
        withTiming(0, { duration: 900, easing: Easing.in(Easing.ease) })
      ),
      -1,
      false
    );
  }, [pulse]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.08 * pulse.value }],
    opacity: 0.6 + 0.4 * (1 - pulse.value),
  }));

  const cutoutX = Math.max(0, rect.x - SPOTLIGHT_PADDING);
  const cutoutY = Math.max(0, rect.y - SPOTLIGHT_PADDING);
  const cutoutW = rect.width + SPOTLIGHT_PADDING * 2;
  const cutoutH = rect.height + SPOTLIGHT_PADDING * 2;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          top: cutoutY,
          left: cutoutX,
          width: cutoutW,
          height: cutoutH,
          borderRadius: SPOTLIGHT_RADIUS,
          borderWidth: 2,
          borderColor: theme.colors.primary,
          ...theme.shadows.glow,
        },
        ringStyle,
      ]}
    />
  );
}

function Callout({
  rect,
  title,
  body,
  onGotIt,
  onSkip,
  stepLabel,
}: {
  rect: TargetRect | null;
  title: string;
  body: string;
  onGotIt: () => void;
  onSkip: () => void;
  stepLabel: string;
}) {
  const opacity = useSharedValue(0);
  const translate = useSharedValue(8);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 220 });
    translate.value = withTiming(0, { duration: 220 });
  }, [opacity, translate, title]);

  // Decide whether to place the callout below or above the target
  const placeBelow =
    !rect || rect.y + rect.height + CALLOUT_MARGIN < SCREEN_HEIGHT / 2;

  // Horizontal position — center on the target, clamped to screen
  let calloutLeft = rect
    ? rect.x + rect.width / 2 - CALLOUT_WIDTH / 2
    : (SCREEN_WIDTH - CALLOUT_WIDTH) / 2;
  calloutLeft = Math.max(
    16,
    Math.min(calloutLeft, SCREEN_WIDTH - CALLOUT_WIDTH - 16)
  );

  const cutoutTop = rect ? Math.max(0, rect.y - SPOTLIGHT_PADDING) : 0;
  const cutoutBottom = rect
    ? cutoutTop + rect.height + SPOTLIGHT_PADDING * 2
    : 0;

  const calloutTop = rect
    ? placeBelow
      ? cutoutBottom + CALLOUT_MARGIN + ARROW_SIZE
      : cutoutTop - CALLOUT_MARGIN - ARROW_SIZE
    : SCREEN_HEIGHT / 2 - 100;

  // Compute arrow position (pointing at target center)
  const arrowLeftWithinCallout = rect
    ? Math.max(
        20,
        Math.min(
          rect.x + rect.width / 2 - calloutLeft - ARROW_SIZE,
          CALLOUT_WIDTH - 40
        )
      )
    : CALLOUT_WIDTH / 2 - ARROW_SIZE;

  // Approximate callout height — used to shift it up when placing above the target.
  const APPROX_CALLOUT_HEIGHT = 160;
  const anchoredTop = placeBelow ? calloutTop : calloutTop - APPROX_CALLOUT_HEIGHT;

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateY: placeBelow ? translate.value : -translate.value },
    ],
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: anchoredTop,
          left: calloutLeft,
          width: CALLOUT_WIDTH,
        },
        animStyle,
      ]}
      pointerEvents="box-none"
    >
      {/* Arrow — placed above or below the card */}
      {rect && (
        <>
          {placeBelow ? (
            <View
              style={{
                position: 'absolute',
                top: -ARROW_SIZE,
                left: arrowLeftWithinCallout,
                width: 0,
                height: 0,
                borderLeftWidth: ARROW_SIZE,
                borderRightWidth: ARROW_SIZE,
                borderBottomWidth: ARROW_SIZE,
                borderLeftColor: 'transparent',
                borderRightColor: 'transparent',
                borderBottomColor: theme.colors.surfaceElevated,
              }}
            />
          ) : (
            <View
              style={{
                position: 'absolute',
                bottom: -ARROW_SIZE,
                left: arrowLeftWithinCallout,
                width: 0,
                height: 0,
                borderLeftWidth: ARROW_SIZE,
                borderRightWidth: ARROW_SIZE,
                borderTopWidth: ARROW_SIZE,
                borderLeftColor: 'transparent',
                borderRightColor: 'transparent',
                borderTopColor: theme.colors.surfaceElevated,
              }}
            />
          )}
        </>
      )}

      <View
        style={{
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radius.lg,
          padding: 18,
          gap: 10,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          ...theme.shadows.card,
        }}
      >
        <Text
          style={{
            color: theme.colors.primary,
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 1.4,
          }}
        >
          {stepLabel}
        </Text>
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
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {body}
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 8,
            gap: 12,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip tour"
            onPress={onSkip}
            hitSlop={12}
            style={{
              minHeight: 44,
              paddingHorizontal: 4,
              justifyContent: 'center',
            }}
          >
            <Text
              style={{
                color: theme.colors.textTertiary,
                fontSize: 13,
                fontWeight: '500',
              }}
            >
              Skip tour
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Got it"
            onPress={onGotIt}
            style={({ pressed }) => ({
              backgroundColor: theme.colors.primary,
              paddingHorizontal: 20,
              paddingVertical: 10,
              borderRadius: theme.radius.full,
              minHeight: 44,
              minWidth: 100,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <Text
              style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}
            >
              Got it
            </Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

export function SpotlightTour() {
  const {
    tourStepId,
    tourStepIndex,
    targets,
    nextStep,
    endTour,
  } = useOnboarding();

  const visible = tourStepId !== null;
  const rect = tourStepId ? targets[tourStepId] ?? null : null;
  const copy = tourStepId ? TOUR_COPY[tourStepId] : null;

  const handleGotIt = () => {
    Haptics.selectionAsync();
    nextStep();
  };

  const handleSkip = () => {
    Haptics.selectionAsync();
    endTour(true);
  };

  if (!visible || !copy) return null;

  const stepLabel = `STEP ${
    (tourStepIndex ?? 0) + 1
  } OF ${TOUR_STEPS.length}`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleSkip}
    >
      <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
        {/* Dark overlay with cutout */}
        <DarkenOverlay rect={rect} />

        {/* Spotlight ring glow */}
        {rect && <SpotlightRing rect={rect} />}

        {/* Invisible pressable over the spotlight to let taps advance the tour */}
        {rect && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.title}
            onPress={handleGotIt}
            style={{
              position: 'absolute',
              top: Math.max(0, rect.y - SPOTLIGHT_PADDING),
              left: Math.max(0, rect.x - SPOTLIGHT_PADDING),
              width: rect.width + SPOTLIGHT_PADDING * 2,
              height: rect.height + SPOTLIGHT_PADDING * 2,
              borderRadius: SPOTLIGHT_RADIUS,
            }}
          />
        )}

        <Callout
          rect={rect}
          title={copy.title}
          body={copy.body}
          onGotIt={handleGotIt}
          onSkip={handleSkip}
          stepLabel={stepLabel}
        />
      </View>
    </Modal>
  );
}
