/**
 * 11-screen animated onboarding — host stepper (feat/onboarding-v2).
 * HERO → PROBLEM → INTENT → SHOT → COURSE → HANDICAP → AGE → BUILD/REVEAL →
 * CAMERA-ROLL AHA → REEL READY → PRO GATE → app/paywall (14-day trial).
 *
 * One screen mounted at a time (the aha holds video + audio) with a
 * cross-fade between steps and an endowed progress bar (starts at 15%).
 * Shown once to first-time unauthenticated visitors (gated in app/_layout
 * via lib/salesFlow — that plumbing is unchanged, so deleting lib/salesFlow
 * + this route group still disconnects the whole feature).
 *
 * Exits (no dead-ends, even with every skippable skipped and the picker
 * cancelled):
 *  - Hero "I already have an account" → login.
 *  - Pro gate "See Pro" → /paywall?from=onboarding (the paywall routes to
 *    signup on close/purchase when it came from here).
 *  - Pro gate "Not now" → signup.
 * All three mark the funnel done + persist answers first.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  HeroScreen,
  ProblemScreen,
  IntentScreen,
  ShotScreen,
  CourseScreen,
  HandicapScreen,
  AgeScreen,
  BuildRevealScreen,
  ReelReadyScreen,
  ProGateScreen,
  type FlowScreenProps,
  type FlowAnswers,
  type AhaOutcome,
} from '@/components/onboarding/flow/Screens';
import { AhaScreen } from '@/components/onboarding/flow/AhaScreen';
import { FlowProgressBar } from '@/components/onboarding/flow/FlowKit';
import { PROGRESS_START } from '@/constants/onboardingV2';
import { markSalesDone, setTrialIntent } from '@/lib/salesFlow';
import {
  saveOnboardingAnswers,
  markOnboardingComplete,
} from '@/lib/onboardingProfile';

const STEPS = [
  HeroScreen, // 1 — hero reel
  ProblemScreen, // 2 — the problem
  IntentScreen, // 3 — intent
  ShotScreen, // 4 — the shot you'd hate to forget
  CourseScreen, // 5 — home course (skippable)
  HandicapScreen, // 6 — handicap band (skippable)
  AgeScreen, // 7 — age range (skippable)
  BuildRevealScreen, // 8 — building → reveal
  AhaScreen, // 9 — camera-roll reel aha
  ReelReadyScreen, // 10 — your reel's ready
  ProGateScreen, // 11 — paywall setup
] as const;

export default function OnboardingFunnel() {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [answers, setAnswersState] = useState<FlowAnswers>({
    intent: null,
    memorableShot: null,
    homeCourseName: null,
    handicap: null,
    ageRange: null,
    vibe: 'cinematic', // default choice architecture — Cinematic pre-selected
  });
  const [ahaOutcome, setAhaOutcome] = useState<AhaOutcome | null>(null);

  // Persist incrementally so answers survive an app kill mid-funnel.
  const setAnswers = useCallback((patch: Partial<FlowAnswers>) => {
    setAnswersState((prev) => ({ ...prev, ...patch }));
    saveOnboardingAnswers(patch).catch(() => {});
  }, []);

  // Throttle advances so a stray double-call (auto-advance + tap) can't
  // skip a screen — same field bug the v1 funnel hit.
  const lastAdvance = useRef(0);
  const advance = useCallback(() => {
    const now = Date.now();
    if (now - lastAdvance.current < 450) return;
    lastAdvance.current = now;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, []);

  const finish = useCallback(
    async (wantsTrial: boolean) => {
      await saveOnboardingAnswers(answers);
      await markOnboardingComplete();
      await setTrialIntent(wantsTrial);
      await markSalesDone();
    },
    [answers]
  );

  const onLogin = useCallback(async () => {
    await finish(false);
    router.replace('/(auth)/login');
  }, [finish]);

  const onSeePro = useCallback(async () => {
    await finish(true);
    // The paywall handles its own exits when it came from onboarding
    // (close / purchase / restore → signup) so the funnel never dead-ends.
    router.replace({ pathname: '/paywall', params: { from: 'onboarding' } });
  }, [finish]);

  const onMaybeLater = useCallback(async () => {
    await finish(false);
    router.replace('/(auth)/signup');
  }, [finish]);

  const Current = STEPS[step];
  const props: FlowScreenProps = useMemo(
    () => ({
      answers,
      setAnswers,
      onNext: advance,
      onSkip: advance,
      onLogin,
      onSeePro,
      onMaybeLater,
      ahaOutcome,
      setAhaOutcome,
    }),
    [answers, setAnswers, advance, onLogin, onSeePro, onMaybeLater, ahaOutcome]
  );

  // Endowed progress: never zero, completes at the pro gate.
  const progress = PROGRESS_START + (1 - PROGRESS_START) * (step / (STEPS.length - 1));

  return (
    <View style={{ flex: 1, backgroundColor: '#0A0A0F' }}>
      <StatusBar style="light" />
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingHorizontal: 24,
          paddingBottom: 6,
        }}
      >
        <FlowProgressBar progress={progress} />
      </View>
      <Animated.View
        key={step}
        entering={FadeIn.duration(280)}
        style={{ flex: 1, paddingBottom: insets.bottom }}
      >
        <Current {...props} />
      </Animated.View>
    </View>
  );
}
