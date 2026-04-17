import { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  Modal,
  StatusBar as RNStatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import {
  Flag,
  Video,
  Sparkles,
  Share2,
  ChevronRight,
} from 'lucide-react-native';
import { theme } from '@/constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type IconName = 'flag' | 'video' | 'sparkles' | 'share';

interface IntroSlide {
  id: string;
  icon: IconName;
  gradient: [string, string];
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
}

export const INTRO_SLIDES: IntroSlide[] = [
  {
    id: 'welcome',
    icon: 'flag',
    gradient: ['#1F5E28', '#0A0A0F'],
    eyebrow: 'WELCOME',
    title: 'Welcome to Clippar',
    body: 'Turn every round into a highlight reel. No editing. No fuss. Just golf that looks great on your phone.',
    cta: 'Next',
  },
  {
    id: 'record',
    icon: 'video',
    gradient: ['#2A4D7A', '#0A0A0F'],
    eyebrow: 'STEP 1',
    title: 'Record or import your round',
    body: 'Hit the big red button at the tee, or drop in clips you already filmed. Either way, we\'ll wrangle them.',
    cta: 'Next',
  },
  {
    id: 'auto-trim',
    icon: 'sparkles',
    gradient: ['#6B4E2C', '#0A0A0F'],
    eyebrow: 'STEP 2',
    title: 'We auto-trim every shot',
    body: 'Clippar watches each clip on-device and keeps just the swing. Your reel stays tight — and private.',
    cta: 'Next',
  },
  {
    id: 'share',
    icon: 'share',
    gradient: ['#4E2C6B', '#0A0A0F'],
    eyebrow: 'STEP 3',
    title: 'Share your PGA-worthy reel',
    body: 'Export a polished highlight cut with scores baked in, then send it to the group chat in one tap.',
    cta: "Let's play",
  },
];

function IconFor({ name, size = 56 }: { name: IconName; size?: number }) {
  const color = theme.colors.primary;
  const strokeWidth = 1.75;
  switch (name) {
    case 'flag':
      return <Flag size={size} color={color} strokeWidth={strokeWidth} />;
    case 'video':
      return <Video size={size} color={color} strokeWidth={strokeWidth} />;
    case 'sparkles':
      return <Sparkles size={size} color={color} strokeWidth={strokeWidth} />;
    case 'share':
      return <Share2 size={size} color={color} strokeWidth={strokeWidth} />;
  }
}

function FloatingIcon({ name }: { name: IconName }) {
  const float = useSharedValue(0);
  const pulse = useSharedValue(0);

  useMemo(() => {
    float.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 2200, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.out(Easing.ease) }),
        withTiming(0, { duration: 1800, easing: Easing.in(Easing.ease) })
      ),
      -1,
      false
    );
  }, [float, pulse]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -8 * float.value }],
  }));

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.25 * pulse.value }],
    opacity: 0.35 * (1 - pulse.value),
  }));

  return (
    <View
      style={{
        width: 160,
        height: 160,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: 140,
            height: 140,
            borderRadius: 70,
            backgroundColor: theme.colors.primary,
          },
          pulseStyle,
        ]}
      />
      <View
        style={{
          width: 120,
          height: 120,
          borderRadius: 60,
          backgroundColor: theme.colors.primaryMuted,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: theme.colors.primary + '66',
        }}
      >
        <Animated.View style={iconStyle}>
          <IconFor name={name} />
        </Animated.View>
      </View>
    </View>
  );
}

function ProgressDots({
  count,
  index,
}: {
  count: number;
  index: number;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            width: i === index ? 24 : 8,
            height: 8,
            borderRadius: 4,
            backgroundColor:
              i === index
                ? theme.colors.primary
                : theme.colors.surfaceBorder,
          }}
        />
      ))}
    </View>
  );
}

interface OnboardingIntroProps {
  visible: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingIntro({
  visible,
  onComplete,
  onSkip,
}: OnboardingIntroProps) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const slide = INTRO_SLIDES[index];
  const isLast = index === INTRO_SLIDES.length - 1;

  const handleNext = useCallback(() => {
    Haptics.selectionAsync();
    if (isLast) {
      onComplete();
      setIndex(0);
    } else {
      setIndex((i) => Math.min(i + 1, INTRO_SLIDES.length - 1));
    }
  }, [isLast, onComplete]);

  const handleSkip = useCallback(() => {
    Haptics.selectionAsync();
    onSkip();
    setIndex(0);
  }, [onSkip]);

  if (!slide) return null;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleSkip}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <RNStatusBar barStyle="light-content" />
        <LinearGradient
          colors={slide.gradient}
          locations={[0, 0.85]}
          style={{
            flex: 1,
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 16,
            paddingHorizontal: 24,
          }}
        >
          {/* Skip button — top right */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              minHeight: 44,
              alignItems: 'center',
            }}
          >
            {!isLast && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Skip onboarding"
                onPress={handleSkip}
                hitSlop={12}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: theme.radius.full,
                  minHeight: 44,
                  minWidth: 64,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 15,
                    fontWeight: '600',
                  }}
                >
                  Skip
                </Text>
              </Pressable>
            )}
          </View>

          {/* Hero visual */}
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 16,
            }}
          >
            <FloatingIcon name={slide.icon} />

            <Text
              style={{
                color: theme.colors.primary,
                fontSize: 12,
                fontWeight: '700',
                letterSpacing: 2,
                marginTop: 32,
              }}
            >
              {slide.eyebrow}
            </Text>

            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 32,
                fontWeight: '800',
                letterSpacing: -0.5,
                textAlign: 'center',
                marginTop: 12,
                maxWidth: SCREEN_WIDTH - 64,
              }}
            >
              {slide.title}
            </Text>

            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 16,
                lineHeight: 24,
                textAlign: 'center',
                marginTop: 16,
                maxWidth: SCREEN_WIDTH - 80,
              }}
            >
              {slide.body}
            </Text>
          </View>

          {/* Bottom: dots + CTA */}
          <View style={{ gap: 20 }}>
            <ProgressDots count={INTRO_SLIDES.length} index={index} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={slide.cta}
              onPress={handleNext}
              style={({ pressed }) => ({
                backgroundColor: theme.colors.primary,
                paddingVertical: 16,
                paddingHorizontal: 24,
                borderRadius: theme.radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 8,
                minHeight: 56,
                opacity: pressed ? 0.9 : 1,
                ...theme.shadows.glow,
              })}
            >
              <Text
                style={{
                  color: '#fff',
                  fontSize: 17,
                  fontWeight: '800',
                  letterSpacing: 0.3,
                }}
              >
                {slide.cta}
              </Text>
              <ChevronRight size={20} color="#fff" strokeWidth={2.5} />
            </Pressable>

            {!isLast && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Skip tour"
                onPress={handleSkip}
                hitSlop={12}
                style={{
                  minHeight: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 14,
                    fontWeight: '500',
                  }}
                >
                  Skip for now
                </Text>
              </Pressable>
            )}
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );
}
