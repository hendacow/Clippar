/**
 * Onboarding v2 answer store (feat/onboarding-v2).
 *
 * Persists the questionnaire answers from the 12-screen animated onboarding
 * (intent, memorable shot, home course, handicap band, age range, reel vibe)
 * locally via
 * lib/storage settings, and exposes typed getters so downstream surfaces —
 * the paywall personalization line, the round-setup course prefill and the
 * home empty-state — can read them without touching the funnel.
 *
 * Kept separate from lib/salesFlow (which owns the show-once gate + trial
 * intent) so either can be removed independently.
 */
import { getSetting, setSetting } from '@/lib/storage';

export type OnboardingIntent = 'relive' | 'share' | 'improve' | 'all';
export type MemorableShot = 'ace' | 'careerRound' | 'perfectDrive' | 'everyGoodOne';
export type OnboardingHandicap =
  | 'plus'
  | 'scratch'
  | 'tidy'
  | 'gettingThere'
  | 'learning'
  | 'noIdea';
export type OnboardingAgeRange = 'under18' | '18to29' | '30to44' | '45to59' | '60plus';
export type ReelVibe = 'chill' | 'hype' | 'cinematic';

export interface OnboardingProfile {
  intent: OnboardingIntent | null;
  memorableShot: MemorableShot | null;
  homeCourseName: string | null;
  handicap: OnboardingHandicap | null;
  ageRange: OnboardingAgeRange | null;
  vibe: ReelVibe | null;
  /** ISO timestamp when the funnel finished (either exit). */
  completedAt: string | null;
}

const KEYS = {
  intent: 'onboarding.v2.intent',
  memorableShot: 'onboarding.v2.memorable_shot',
  homeCourseName: 'onboarding.v2.home_course',
  handicap: 'onboarding.v2.handicap',
  ageRange: 'onboarding.v2.age_range',
  vibe: 'onboarding.v2.vibe',
  completedAt: 'onboarding.v2.completed_at',
} as const;

const INTENTS: OnboardingIntent[] = ['relive', 'share', 'improve', 'all'];
const SHOTS: MemorableShot[] = ['ace', 'careerRound', 'perfectDrive', 'everyGoodOne'];
const HANDICAPS: OnboardingHandicap[] = [
  'plus',
  'scratch',
  'tidy',
  'gettingThere',
  'learning',
  'noIdea',
];
const AGE_RANGES: OnboardingAgeRange[] = ['under18', '18to29', '30to44', '45to59', '60plus'];
const VIBES: ReelVibe[] = ['chill', 'hype', 'cinematic'];

function pick<T extends string>(raw: string | null, allowed: T[]): T | null {
  return raw && (allowed as string[]).includes(raw) ? (raw as T) : null;
}

export async function saveOnboardingAnswers(
  answers: Partial<Omit<OnboardingProfile, 'completedAt'>>
): Promise<void> {
  try {
    if (answers.intent !== undefined && answers.intent !== null)
      await setSetting(KEYS.intent, answers.intent);
    if (answers.memorableShot !== undefined && answers.memorableShot !== null)
      await setSetting(KEYS.memorableShot, answers.memorableShot);
    if (answers.homeCourseName !== undefined && answers.homeCourseName !== null)
      await setSetting(KEYS.homeCourseName, answers.homeCourseName);
    if (answers.handicap !== undefined && answers.handicap !== null)
      await setSetting(KEYS.handicap, answers.handicap);
    if (answers.ageRange !== undefined && answers.ageRange !== null)
      await setSetting(KEYS.ageRange, answers.ageRange);
    if (answers.vibe !== undefined && answers.vibe !== null)
      await setSetting(KEYS.vibe, answers.vibe);
  } catch {
    // Best-effort — losing an answer only costs a personalization line.
  }
}

export async function markOnboardingComplete(): Promise<void> {
  try {
    await setSetting(KEYS.completedAt, new Date().toISOString());
  } catch {}
}

export async function getOnboardingProfile(): Promise<OnboardingProfile> {
  try {
    const [intent, shot, course, handicap, ageRange, vibe, completedAt] = await Promise.all([
      getSetting(KEYS.intent),
      getSetting(KEYS.memorableShot),
      getSetting(KEYS.homeCourseName),
      getSetting(KEYS.handicap),
      getSetting(KEYS.ageRange),
      getSetting(KEYS.vibe),
      getSetting(KEYS.completedAt),
    ]);
    return {
      intent: pick(intent, INTENTS),
      memorableShot: pick(shot, SHOTS),
      homeCourseName: course && course.trim() ? course.trim() : null,
      handicap: pick(handicap, HANDICAPS),
      ageRange: pick(ageRange, AGE_RANGES),
      vibe: pick(vibe, VIBES),
      completedAt: completedAt ?? null,
    };
  } catch {
    return {
      intent: null,
      memorableShot: null,
      homeCourseName: null,
      handicap: null,
      ageRange: null,
      vibe: null,
      completedAt: null,
    };
  }
}

/* ── Copy helpers (single source for every surface that echoes answers) ── */

/** "tuned for [reliving your best shots]" — reveal + paywall echo. */
export const intentEcho: Record<OnboardingIntent, string> = {
  relive: 'reliving your best shots',
  share: 'sharing with your group',
  improve: 'seeing your swing clearly',
  all: 'all of it',
};

/** "[your best shots]" loader echo for the memorable-shot answer. */
export const shotEcho: Record<MemorableShot, string> = {
  ace: 'the ace when it happens',
  careerRound: 'the career round',
  perfectDrive: 'that one perfect drive',
  everyGoodOne: 'every good one',
};

/** Home empty-state line keyed off the shot they said they'd hate to lose. */
export const shotEmptyStateLine: Record<MemorableShot, string> = {
  ace: "Next time the ace (or the near-miss) happens, it'll be on film.",
  careerRound: 'Your next career round deserves the footage.',
  perfectDrive: 'That one perfect drive — filmed this time.',
  everyGoodOne: 'Every good one, on film from here on.',
};
