/**
 * Onboarding variant selection + funnel telemetry.
 *
 * Before this file, v1 recorded NOTHING about where people fell out of
 * onboarding — a v1/v2 comparison had no baseline. Events go two places:
 * a tagged Sentry message (infrastructure we already have; no new SDK) and
 * a local ring buffer for on-device debugging via Diagnostics.
 *
 * Variant: 'v1' is the shipped 5-screen stepper and stays the production
 * default until v2 measurably beats it. Dev builds default to 'v2' (the
 * cinematic flow) so Henry always sees the newest thing; a local_settings
 * override lets either build force either variant for comparison.
 */
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { getSetting, setSetting } from '@/lib/storage';

// v1 = shipped 5-screen stepper (production default until beaten).
// v2 = full cinematic theatre (kept as a variant at Henry's instruction).
// v3 = short cinematic hook -> signup -> REAL-interface tutorial on a
//      scoped scratch round (the approved reordered funnel, plan §12).
export type OnboardingVariant = 'v1' | 'v2' | 'v3';

const VARIANT_KEY = 'onboarding.variant';
const FUNNEL_KEY = 'onboarding.funnel.log';
const FUNNEL_MAX = 200;

export async function getOnboardingVariant(): Promise<OnboardingVariant> {
  try {
    const override = await getSetting(VARIANT_KEY);
    if (override === 'v1' || override === 'v2' || override === 'v3') return override;
  } catch {}
  // app.config.js stamps extra.variant from APP_VARIANT at build time.
  const appVariant = (Constants.expoConfig?.extra as { variant?: string } | undefined)?.variant;
  // v3 becomes the dev default when its record-screen coach lands; until
  // then defaulting to it would strand a fresh signup on a coach-less round.
  return appVariant === 'development' ? 'v2' : 'v1';
}

export async function setOnboardingVariant(v: OnboardingVariant): Promise<void> {
  try {
    await setSetting(VARIANT_KEY, v);
  } catch {}
}

export type FunnelEvent = 'enter' | 'complete' | 'skip' | 'abandon';

export interface FunnelEntry {
  variant: OnboardingVariant;
  step: string;
  event: FunnelEvent;
  msInStep: number;
  at: string;
}

/** Fire-and-forget: telemetry must never slow a transition or throw into UI. */
export function logFunnel(variant: OnboardingVariant, step: string, event: FunnelEvent, msInStep: number): void {
  const entry: FunnelEntry = { variant, step, event, msInStep, at: new Date().toISOString() };
  try {
    Sentry.addBreadcrumb({ category: 'onboarding', message: `${variant}:${step}:${event}`, data: { msInStep } });
    // One message per step-event keeps the Sentry side countable without a
    // real analytics product. Info level: these are not errors.
    Sentry.captureMessage(`onboarding_funnel ${variant} ${step} ${event}`, {
      level: 'info',
      tags: { onboarding_variant: variant, onboarding_step: step, onboarding_event: event },
    } as never);
  } catch {}
  void (async () => {
    try {
      const raw = await getSetting(FUNNEL_KEY);
      const list = raw ? ((JSON.parse(raw) as FunnelEntry[]) ?? []) : [];
      list.push(entry);
      await setSetting(FUNNEL_KEY, JSON.stringify(list.slice(-FUNNEL_MAX)));
    } catch {}
  })();
}
