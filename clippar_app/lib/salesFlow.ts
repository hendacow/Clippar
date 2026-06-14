/**
 * Persistence + gating for the cold-start sales funnel (feat/onboarding-flow).
 * Kept standalone so the whole feature is easy to disconnect: deleting this
 * file + the (onboarding) route + the gate hunk reverts to stock behavior.
 */
import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '@/lib/storage';
import type { HandicapBand, GolferGoal } from '@/constants/onboardingFlow';

const DONE_KEY = 'onboarding.sales_done';
const HANDICAP_KEY = 'onboarding.sales_handicap';
const GOAL_KEY = 'onboarding.sales_goal';
const TRIAL_INTENT_KEY = 'onboarding.sales_wants_trial';

export async function getSalesDone(): Promise<boolean> {
  try {
    return (await getSetting(DONE_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function markSalesDone(): Promise<void> {
  try {
    await setSetting(DONE_KEY, '1');
  } catch {}
}

export async function saveSalesAnswers(handicap: HandicapBand | null, goal: GolferGoal | null) {
  try {
    if (handicap) await setSetting(HANDICAP_KEY, handicap);
    if (goal) await setSetting(GOAL_KEY, goal);
  } catch {}
}

/** Remember that the cold visitor opted into the trial, so the real paywall
 *  can be surfaced right after they create an account. */
export async function setTrialIntent(wants: boolean): Promise<void> {
  try {
    await setSetting(TRIAL_INTENT_KEY, wants ? '1' : '0');
  } catch {}
}

export async function consumeTrialIntent(): Promise<boolean> {
  try {
    const v = (await getSetting(TRIAL_INTENT_KEY)) === '1';
    await setSetting(TRIAL_INTENT_KEY, '0');
    return v;
  } catch {
    return false;
  }
}

/** Auth-gate helper: has the cold-start funnel already been seen/finished? */
export function useSalesFlowDone(): { loaded: boolean; done: boolean } {
  const [state, setState] = useState({ loaded: false, done: false });
  useEffect(() => {
    let alive = true;
    getSalesDone().then((done) => alive && setState({ loaded: true, done }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
