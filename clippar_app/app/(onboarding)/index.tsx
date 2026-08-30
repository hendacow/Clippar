/**
 * Fast-to-value onboarding — host stepper.
 * PROOF → ONE PERSONALISATION → CAMERA-ROLL/SAMPLE AHA → SUCCESS → PRO.
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
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  HeroScreen,
  IntentScreen,
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
import { getOnboardingVariant, logFunnel, type OnboardingVariant } from '@/lib/onboardingFunnel';
import { CinematicOnboarding } from '@/components/onboarding/cinematic/CinematicOnboarding';

const STEPS = [
  HeroScreen, // 1 — show the finished value first
  IntentScreen, // 2 — one-tap personalisation
  AhaScreen, // 3 — make a reel or run the honest sample
  ReelReadyScreen, // 4 — concise success beat
  ProGateScreen, // 5 — optional paid handoff
] as const;

// Step names for funnel telemetry — index-aligned with STEPS.
const STEP_NAMES = ['HERO', 'INTENT', 'AHA', 'REEL_READY', 'PRO_GATE'] as const;
// The v2 cinematic flow hands off INTO this stepper at the Aha step —
// "watch Henry, then make yours" — so the camera-roll moment is shared by
// both variants rather than rebuilt.
const AHA_STEP_INDEX = 2;

export default function OnboardingFunnel() {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  // null = variant not resolved yet (one async read); render nothing rather
  // than flashing v1 for a frame on a v2 device.
  const [variant, setVariant] = useState<OnboardingVariant | null>(null);
  useEffect(() => {
    getOnboardingVariant()
      .then((v) => {
        setVariant(v);
        if (v === 'v1') logFunnel('v1', STEP_NAMES[0], 'enter', 0);
      })
      .catch(() => setVariant('v1'));
  }, []);
  // v1 funnel telemetry: entering each step. v2 logs its own scenes.
  const stepEnteredAt = useRef(Date.now());
  useEffect(() => {
    if (variant !== 'v1' || step === 0) return;
    logFunnel('v1', STEP_NAMES[step] ?? String(step), 'enter', 0);
    stepEnteredAt.current = Date.now();
  }, [step, variant]);
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
      logFunnel(variant ?? 'v1', STEP_NAMES[step] ?? String(step), 'complete', Date.now() - stepEnteredAt.current);
      await saveOnboardingAnswers(answers);
      await markOnboardingComplete();
      await setTrialIntent(wantsTrial);
      await markSalesDone();
    },
    [answers, variant, step]
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

  // Variant branch lives BELOW every hook. Early-returning above the
  // useMemo made the v2->v1 handoff render MORE hooks than the previous
  // render ("Rendered more hooks than during the previous render") — caught
  // live in the simulator pass, which is exactly what it exists for.
  if (variant === null) {
    return <View style={{ flex: 1, backgroundColor: '#0A0A0F' }} />;
  }
  if (variant === 'v2') {
    return (
      <CinematicOnboarding
        onDone={() => {
          // Hand off into the real funnel at the Aha step — the tutorial
          // sold it; now they make their own from the camera roll.
          setStep(AHA_STEP_INDEX);
          setVariant('v1');
          logFunnel('v2', 'HANDOFF', 'complete', 0);
        }}
        onSkip={() => {
          setStep(AHA_STEP_INDEX);
          setVariant('v1');
        }}
      />
    );
  }

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
