/**
 * Screens 1-8, 10 and 11 of the animated onboarding (screen 9 — the
 * camera-roll aha — lives in AhaScreen.tsx). Pure presentational components
 * driven by the host stepper in app/(onboarding)/index.tsx.
 *
 * Copy comes straight from the onboarding spec: confident and warm, the
 * memory not the stats, no fabricated social proof.
 */
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  FadeIn,
  useReducedMotion,
} from 'react-native-reanimated';
import { Check, Sparkles } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { FlowButton, TapChip } from '../sales/primitives';
import { FlowScreen, Rise, H1, Sub, SkipLink } from './FlowKit';
import { MockReel } from './MockReel';
import { CourseAutocomplete } from './CourseAutocomplete';
import {
  intentOptions,
  shotOptions,
  handicapOptionsV2,
  ageRangeOptions,
  ageScreenCopy,
  problemCopy,
} from '@/constants/onboardingV2';
import {
  intentEcho,
  shotEcho,
  type OnboardingIntent,
  type MemorableShot,
  type OnboardingHandicap,
  type OnboardingAgeRange,
  type ReelVibe,
} from '@/lib/onboardingProfile';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export interface FlowAnswers {
  intent: OnboardingIntent | null;
  memorableShot: MemorableShot | null;
  homeCourseName: string | null;
  handicap: OnboardingHandicap | null;
  ageRange: OnboardingAgeRange | null;
  vibe: ReelVibe;
}

/** How screen 9 actually ended — drives honest copy on screens 10 & 11. */
export type AhaOutcome = 'real' | 'sample';

export interface FlowScreenProps {
  answers: FlowAnswers;
  setAnswers: (patch: Partial<FlowAnswers>) => void;
  onNext: () => void;
  onSkip: () => void;
  /** Hero secondary — existing users exit to login. */
  onLogin: () => void;
  /** Screen 11 primary — hand off to the paywall. */
  onSeePro: () => void;
  /** Screen 11 secondary — decline path (still forward: signup). */
  onMaybeLater: () => void;
  ahaOutcome: AhaOutcome | null;
  setAhaOutcome: (o: AhaOutcome) => void;
}

/* ════════════════════ 1. HERO REEL ════════════════════ */

export function HeroScreen({ onNext, onLogin }: FlowScreenProps) {
  const reelW = SCREEN_W - 48;
  const reelH = Math.min(SCREEN_H * 0.42, reelW * 1.15);
  return (
    <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 8 }}>
      <Rise delay={80} style={{ alignItems: 'center' }}>
        <MockReel width={reelW} height={reelH} />
      </Rise>
      <View style={{ flex: 1, justifyContent: 'flex-end', gap: 4, paddingBottom: 8 }}>
        <Rise delay={220}>
          <H1>Your round deserves a highlight reel.</H1>
        </Rise>
        <Rise delay={340}>
          <Sub>Not a scorecard. Not stats. The actual footage of the shots you'll retell.</Sub>
        </Rise>
        <Rise delay={460} style={{ gap: 12, marginTop: 20 }}>
          <FlowButton label="Show me" onPress={onNext} />
          <Pressable onPress={onLogin} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.secondaryLink}>I already have an account</Text>
          </Pressable>
        </Rise>
      </View>
    </View>
  );
}

/* ════════════════════ 2. THE PROBLEM ════════════════════ */

export function ProblemScreen({ onNext }: FlowScreenProps) {
  return (
    <FlowScreen
      title={problemCopy.title}
      sub={problemCopy.sub}
      center
      footer={<FlowButton label={problemCopy.cta} onPress={onNext} />}
    >
      <Rise delay={300} style={{ marginTop: 32, gap: 14 }}>
        {problemCopy.rows.map((row, i) => (
          <FadingShotRow key={row.label} label={row.label} detail={row.detail} delay={i * 180} />
        ))}
      </Rise>
    </FlowScreen>
  );
}

function FadingShotRow({ label, detail, delay }: { label: string; detail: string; delay: number }) {
  const reduceMotion = useReducedMotion();
  const fade = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      fade.value = 0.45;
      return;
    }
    fade.value = withRepeat(
      withTiming(0.35, { duration: 2200, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, [fade, reduceMotion]);
  const a = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Rise delay={delay}>
      <Animated.View style={[styles.memoryRow, a]}>
        <View style={styles.memoryDot} />
        <View style={{ flex: 1 }}>
          <Text style={styles.memoryLabel}>{label}</Text>
          <Text style={styles.memoryAge}>{detail}</Text>
        </View>
      </Animated.View>
    </Rise>
  );
}

/* ════════════════════ 3. INTENT ════════════════════ */

export function IntentScreen({ answers, setAnswers, onNext }: FlowScreenProps) {
  return (
    <FlowScreen title="What's Clippar for, for you?" sub="Pick one — we'll build around it.">
      <View style={{ gap: 12, marginTop: 28 }}>
        {intentOptions.map((o, i) => (
          <TapChip
            key={o.id}
            label={o.label}
            selected={answers.intent === o.id}
            dimmed={answers.intent !== null && answers.intent !== o.id}
            delay={i * 70}
            onPress={() => {
              setAnswers({ intent: o.id });
              setTimeout(onNext, 280);
            }}
          />
        ))}
      </View>
    </FlowScreen>
  );
}

/* ════════════════════ 4. THE SHOT YOU'D HATE TO FORGET ════════════════════ */

export function ShotScreen({ answers, setAnswers, onNext }: FlowScreenProps) {
  return (
    <View style={{ flex: 1 }}>
      {/* Emotional-peak backdrop: slow-falling ball drop behind the cards. */}
      <BallDropBackdrop />
      <FlowScreen
        title="What's the one you'd hate to lose?"
        sub="Most golfers have zero footage of theirs. That ends here."
      >
        <View style={{ gap: 12, marginTop: 28 }}>
          {shotOptions.map((o, i) => (
            <TapChip
              key={o.id}
              label={o.label}
              selected={answers.memorableShot === o.id}
              dimmed={answers.memorableShot !== null && answers.memorableShot !== o.id}
              delay={i * 70}
              onPress={() => {
                setAnswers({ memorableShot: o.id });
                setTimeout(() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  onNext();
                }, 280);
              }}
            />
          ))}
        </View>
      </FlowScreen>
    </View>
  );
}

function BallDropBackdrop() {
  const reduceMotion = useReducedMotion();
  const fall = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    fall.value = withRepeat(
      withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.quad) }),
      -1,
      false
    );
  }, [fall, reduceMotion]);
  const a = useAnimatedStyle(() => ({
    opacity: 0.16 * Math.sin(Math.PI * fall.value),
    transform: [{ translateY: -80 + fall.value * (SCREEN_H * 0.7) }],
  }));
  if (reduceMotion) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: SCREEN_W * 0.72,
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: '#fff',
        },
        a,
      ]}
    />
  );
}

/* ════════════════════ 5. HOME COURSE (skippable) ════════════════════ */

export function CourseScreen({ answers, setAnswers, onNext, onSkip }: FlowScreenProps) {
  const [text, setText] = useState(answers.homeCourseName ?? '');
  const commit = (name: string) => {
    const trimmed = name.trim();
    if (trimmed) setAnswers({ homeCourseName: trimmed });
    onNext();
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
    <FlowScreen
      title="Where do you play most?"
      sub="Your course shows up on your reels' end-card."
      footer={
        <>
          <FlowButton label="That's my track" onPress={() => commit(text)} />
          <Pressable onPress={onSkip} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.secondaryLink}>Skip — I play all over</Text>
          </Pressable>
        </>
      }
    >
      <Rise delay={220} style={{ marginTop: 28 }}>
        <CourseAutocomplete
          value={text}
          onChangeText={setText}
          onSelect={(name) => {
            setText(name);
            setAnswers({ homeCourseName: name });
            Haptics.selectionAsync();
          }}
        />
      </Rise>
    </FlowScreen>
    </KeyboardAvoidingView>
  );
}

/* ════════════════════ 6. HANDICAP BAND (skippable) ════════════════════ */

export function HandicapScreen({ answers, setAnswers, onNext, onSkip }: FlowScreenProps) {
  return (
    <FlowScreen
      title="Where's your game at?"
      sub="No sandbagging — just helps us tune things."
      footer={
        <View style={{ alignItems: 'center' }}>
          <SkipLink label="Skip this one" onPress={onSkip} />
        </View>
      }
    >
      <View style={{ gap: 10, marginTop: 24 }}>
        {handicapOptionsV2.map((o, i) => (
          <TapChip
            key={o.id}
            label={o.label}
            selected={answers.handicap === o.id}
            dimmed={answers.handicap !== null && answers.handicap !== o.id}
            delay={i * 60}
            onPress={() => {
              setAnswers({ handicap: o.id });
              setTimeout(onNext, 280);
            }}
          />
        ))}
      </View>
    </FlowScreen>
  );
}

/* ════════════════════ 7. AGE RANGE (skippable) ════════════════════ */

export function AgeScreen({ answers, setAnswers, onNext, onSkip }: FlowScreenProps) {
  return (
    <FlowScreen
      title={ageScreenCopy.title}
      sub={ageScreenCopy.sub}
      footer={
        <View style={{ alignItems: 'center' }}>
          <SkipLink label={ageScreenCopy.skip} onPress={onSkip} />
        </View>
      }
    >
      <View style={{ gap: 10, marginTop: 24 }}>
        {ageRangeOptions.map((o, i) => (
          <TapChip
            key={o.id}
            label={o.label}
            selected={answers.ageRange === o.id}
            dimmed={answers.ageRange !== null && answers.ageRange !== o.id}
            delay={i * 60}
            onPress={() => {
              setAnswers({ ageRange: o.id });
              setTimeout(onNext, 280);
            }}
          />
        ))}
      </View>
    </FlowScreen>
  );
}

/* ════════════════════ 8. BUILDING → REVEAL (one beat) ════════════════════ */

export function BuildRevealScreen({ answers, onNext }: FlowScreenProps) {
  const [phase, setPhase] = useState<'loading' | 'reveal'>('loading');
  const [done, setDone] = useState(-1);
  const spin = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  const course = answers.homeCourseName ?? 'your local track';
  const shots = answers.memorableShot ? shotEcho[answers.memorableShot] : 'your best shots';
  const intent = answers.intent ? intentEcho[answers.intent] : 'reliving your best shots';

  const lines = [`Tuning for ${course}`, `Prioritising ${shots}`, 'Tracer on…'];

  useEffect(() => {
    if (!reduceMotion) {
      spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1);
    }
    // Genuinely short (~2.4s): a highlight app isn't plausibly "computing"
    // for longer, and the critics were right that two screens is one too many.
    const timers = lines.map((_, i) =>
      setTimeout(() => {
        setDone(i);
        Haptics.selectionAsync();
        if (i === lines.length - 1) {
          setTimeout(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setPhase('reveal');
          }, 550);
        }
      }, 550 + i * 620)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ring = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  if (phase === 'loading') {
    return (
      <View style={styles.loaderWrap}>
        <Animated.View style={[ring, styles.loaderRing]} />
        <H1 center>Building your Clippar…</H1>
        <View style={{ gap: 14, alignSelf: 'stretch', paddingHorizontal: 12 }}>
          {lines.map((l, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={[
                  styles.checkDot,
                  { backgroundColor: done >= i ? theme.colors.primary : theme.colors.surfaceElevated },
                ]}
              >
                {done >= i ? <Check size={14} color="#fff" /> : null}
              </View>
              <Text
                style={{
                  color: done >= i ? theme.colors.textPrimary : theme.colors.textTertiary,
                  fontSize: 15,
                  fontWeight: '600',
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {l}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(reduceMotion ? 150 : 350)} style={{ flex: 1 }}>
      <FlowScreen
        title="Alright — this is your Clippar."
        sub={`Reels from ${course}, tuned for ${intent}, tracer on, ready to share.`}
        center
        footer={<FlowButton label="Show me the good part" onPress={onNext} />}
      >
        <Rise delay={260} style={{ alignItems: 'center', marginTop: 28 }}>
          <View style={styles.revealBadge}>
            <Sparkles size={16} color={theme.colors.primary} />
            <Text style={styles.revealBadgeText}>Built from your answers</Text>
          </View>
        </Rise>
      </FlowScreen>
    </Animated.View>
  );
}

/* ════════════════════ 10. YOUR REEL'S READY ════════════════════ */

export function ReelReadyScreen({ ahaOutcome, onNext }: FlowScreenProps) {
  const real = ahaOutcome !== 'sample';
  return (
    <FlowScreen
      title={real ? 'Boom — there’s your reel.' : 'That’s what a reel looks like.'}
      sub={
        real
          ? 'Made in one tap. Imagine this every round.'
          : 'Yours will star your own swings. Imagine this every round.'
      }
      center
      footer={<FlowButton label="Keep going" onPress={onNext} />}
    >
      <Rise delay={260} style={{ alignItems: 'center', marginTop: 24 }}>
        <View style={styles.revealBadge}>
          <Check size={16} color={theme.colors.primary} />
          <Text style={styles.revealBadgeText}>{real ? 'Your first reel, done' : 'One tap when you have a clip'}</Text>
        </View>
      </Rise>
    </FlowScreen>
  );
}

/* ════════════════════ 11. PAYWALL SETUP ════════════════════ */

export function ProGateScreen({ ahaOutcome, onSeePro, onMaybeLater }: FlowScreenProps) {
  const real = ahaOutcome !== 'sample';
  return (
    <FlowScreen
      title={real ? 'You’ve made your first reel.' : 'Your first reel is one tap away.'}
      sub={
        real
          ? // Honest claim only: the aha clip is NOT persisted into the library
            // after signup (it lives in cache), so never promise "keeps this one".
            'Free Clippar makes reels like this from your rounds, with a small watermark. To keep them coming — HD, no watermark, straight to your group — you’ll want Clippar Pro.'
          : 'Free Clippar makes it, with a small watermark. To keep making them — HD, no watermark, straight to your group — you’ll want Clippar Pro.'
      }
      center
      footer={
        <>
          <FlowButton label="See Pro" onPress={onSeePro} />
          <Pressable onPress={onMaybeLater} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.secondaryLink}>Not now — set up my account</Text>
          </Pressable>
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  secondaryLink: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
    paddingVertical: 4,
  },
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 14,
  },
  memoryDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.textTertiary,
  },
  memoryLabel: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  memoryAge: {
    color: theme.colors.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    paddingHorizontal: 24,
  },
  loaderRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 4,
    borderColor: theme.colors.surfaceBorder,
    borderTopColor: theme.colors.primary,
  },
  checkDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.primaryMuted,
    borderRadius: theme.radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  revealBadgeText: {
    color: theme.colors.primaryLight,
    fontSize: 13,
    fontWeight: '700',
  },
});
