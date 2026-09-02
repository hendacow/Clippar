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

// ---- Replaying the cinematic intro on a device that has finished it -------
//
// The funnel is reachable only when signed OUT and sales_done is unset, which
// on a real handset means it can never be seen again once completed — the
// profile's "Replay onboarding" clears the in-app TOUR flags, which is a
// different feature entirely. That left no way to review this work on a phone
// short of deleting the app, so: this flag, one narrow exception in the root
// auth gate, and a button in diagnostics.
//
// Deliberately module-level rather than persisted: it lives exactly as long as
// the replay does and cannot survive a relaunch into a state where a signed-in
// golfer is stuck in the funnel.
let replayingIntro = false;

export function isReplayingIntro(): boolean {
  return replayingIntro;
}

export function endIntroReplay(): void {
  replayingIntro = false;
}

/** Clear the funnel's completion so it plays again, and open the gate for it. */
export async function beginIntroReplay(): Promise<void> {
  replayingIntro = true;
  try {
    await setSetting(DONE_KEY, null);
    await setSetting('onboarding.v2.completed_at', null);
    await setSetting('onboarding.v2.scene', null);
  } catch {}
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
