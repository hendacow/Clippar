/**
 * Cold-start golfer sales funnel — host stepper.
 * HOOK → MICRO-COMMIT ×2 → VALUE ×3 → LOADER → PROOF → PAYWALL.
 *
 * One screen mounted at a time (heavy video) with a cross-fade between steps.
 * Shown once to first-time unauthenticated visitors (gated in app/_layout via
 * lib/salesFlow). The funnel never holds an account — its exits route into the
 * existing signup/login, carrying the trial intent for the post-signup paywall.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  HookIntro,
  QHandicap,
  QGoal,
  ValueAutocut,
  ValueTracer,
  ValueShare,
  BuildingLoader,
  ProofWall,
  PaywallPreview,
  type ScreenProps,
} from '@/components/onboarding/sales/Screens';
import {
  markSalesDone,
  saveSalesAnswers,
  setTrialIntent,
} from '@/lib/salesFlow';
import type { HandicapBand, GolferGoal } from '@/constants/onboardingFlow';

const STEPS = [
  HookIntro,
  QHandicap,
  QGoal,
  ValueAutocut,
  ValueTracer,
  ValueShare,
  BuildingLoader,
  ProofWall,
  PaywallPreview,
] as const;

export default function SalesFunnel() {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [handicap, setHandicapState] = useState<HandicapBand | null>(null);
  const [goal, setGoalState] = useState<GolferGoal | null>(null);

  const finishTo = useCallback(
    async (dest: '/(auth)/signup' | '/(auth)/login', wantsTrial: boolean) => {
      await saveSalesAnswers(handicap, goal);
      await setTrialIntent(wantsTrial);
      await markSalesDone();
      router.replace(dest);
    },
    [handicap, goal]
  );

  // Throttle advances so a stray double-call (auto-advance + tap) can't skip
  // a screen — observed handicap jumping straight past the goal question.
  const lastAdvance = useRef(0);
  const advance = useCallback(() => {
    const now = Date.now();
    if (now - lastAdvance.current < 450) return;
    lastAdvance.current = now;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, []);
  const onNext = advance;
  const onSkip = advance;

  const setHandicap = useCallback((h: HandicapBand) => setHandicapState(h), []);
  const setGoal = useCallback((g: GolferGoal) => setGoalState(g), []);

  // Primary = convert (carry trial intent → signup). Secondary depends on screen:
  // Hook = "I have an account" → login; Paywall = "Maybe later" → signup, no trial.
  const Current = STEPS[step];
  const isPaywall = step === STEPS.length - 1;

  const props: ScreenProps = useMemo(
    () => ({
      onNext,
      onSkip,
      onPrimary: () => finishTo('/(auth)/signup', true),
      onSecondary: isPaywall
        ? () => finishTo('/(auth)/signup', false)
        : () => finishTo('/(auth)/login', false),
      handicap,
      goal,
      setHandicap,
      setGoal,
    }),
    [onNext, onSkip, finishTo, isPaywall, handicap, goal, setHandicap, setGoal]
  );

  // Hook screen is full-bleed video (its own safe-area handling); others inset.
  const padTop = step === 0 ? 0 : insets.top;
  const padBottom = step === 0 ? 0 : insets.bottom;

  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0F' }}>
      <StatusBar style="light" />
      <Animated.View
        key={step}
        entering={FadeIn.duration(280)}
        style={{ flex: 1, paddingTop: padTop, paddingBottom: padBottom }}
      >
        <Current {...props} />
      </Animated.View>
    </View>
  );
}
