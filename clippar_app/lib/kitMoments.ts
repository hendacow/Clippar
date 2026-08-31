/**
 * Earned kit moments — observations, never pitches.
 *
 * Henry's rule (ratified 31 Aug, plan §13.6 as amended): NO kit content
 * anywhere in onboarding. In-app, the kit appears only at moments where the
 * user is already inside the problem it solves, and every line must pass the
 * test: a PITCH says "buy the kit"; an OBSERVATION states a fact about the
 * user's own round and lets them draw the conclusion. Only observations ship.
 * These moments are the entire commercial path of a free app whose revenue
 * is kit units — they are written as carefully as the numbers behind them.
 *
 * The load-bearing number: "you walked back to your phone N times" must be
 * GENUINELY derived (the clip count of their own just-finished round,
 * recorded at round end together with whether a clicker was connected).
 * A wrong or invented count destroys the device — so no fact recorded, no
 * card shown. Never a placeholder.
 */
import { getSetting, setSetting } from '@/lib/storage';

const FACTS_KEY = 'kit.last_round_facts';        // {shots, usedClicker, at}
const SEEN_WALKBACK = 'kit.seen.walkback_week';  // ISO week stamp — once/week max
const SEEN_FIRSTROUND = 'kit.seen.first_round';
const SEEN_PRACTICE = 'kit.seen.practice_setup';

export interface RoundFacts {
  shots: number;
  usedClicker: boolean;
  at: string;
}

/** Call at round end, from the round the user actually played. */
export async function recordRoundFacts(shots: number, usedClicker: boolean): Promise<void> {
  try {
    if (!Number.isFinite(shots) || shots <= 0) return; // no fact, no card
    const facts: RoundFacts = { shots, usedClicker, at: new Date().toISOString() };
    await setSetting(FACTS_KEY, JSON.stringify(facts));
  } catch {}
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${week}`;
}

export type HomeKitMoment =
  | { kind: 'walkback'; shots: number }
  | { kind: 'first-round' }
  | null;

/**
 * At most ONE card, and only when its trigger genuinely fired:
 * - walkback: their latest finished round had shots and no clicker. Weekly cap.
 * - first-round: their first finished self-filmed round ever. Once.
 */
export async function getPendingHomeMoment(): Promise<HomeKitMoment> {
  try {
    const raw = await getSetting(FACTS_KEY);
    if (!raw) return null;
    const facts = JSON.parse(raw) as RoundFacts;
    if (!facts || !Number.isFinite(facts.shots) || facts.shots <= 0) return null;

    const firstSeen = await getSetting(SEEN_FIRSTROUND);
    if (!firstSeen) return { kind: 'first-round' };

    if (!facts.usedClicker) {
      const stamp = isoWeek(new Date());
      const seenWeek = await getSetting(SEEN_WALKBACK);
      if (seenWeek !== stamp) return { kind: 'walkback', shots: facts.shots };
    }
    return null;
  } catch {
    return null;
  }
}

export async function markHomeMomentSeen(kind: 'walkback' | 'first-round'): Promise<void> {
  try {
    if (kind === 'first-round') await setSetting(SEEN_FIRSTROUND, '1');
    else await setSetting(SEEN_WALKBACK, isoWeek(new Date()));
  } catch {}
}

export async function isPracticeSetupSeen(): Promise<boolean> {
  try {
    return (await getSetting(SEEN_PRACTICE)) === '1';
  } catch {
    return true;
  }
}

export async function markPracticeSetupSeen(): Promise<void> {
  try {
    await setSetting(SEEN_PRACTICE, '1');
  } catch {}
}
