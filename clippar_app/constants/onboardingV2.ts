/**
 * Content for the 10-screen animated onboarding (feat/onboarding-v2).
 *
 * Everything copy-ish lives here so wording can be tuned without touching
 * screen code. Voice: confident and warm. No fabricated social proof —
 * no user counts, no ratings, no testimonials until real ones exist.
 */
import { defaultTrackForVibe } from '@/lib/musicLibrary';
import type {
  OnboardingIntent,
  MemorableShot,
  OnboardingHandicap,
  ReelVibe,
} from '@/lib/onboardingProfile';

/** Endowed progress (Kivetz et al.): the bar never starts at zero. */
export const PROGRESS_START = 0.15;

export const intentOptions: { id: OnboardingIntent; label: string }[] = [
  { id: 'relive', label: 'Relive my best shots' },
  { id: 'share', label: 'Share with my group' },
  { id: 'improve', label: 'See my swing to actually improve' },
  { id: 'all', label: 'All of it' },
];

export const shotOptions: { id: MemorableShot; label: string }[] = [
  { id: 'ace', label: 'An ace (or my closest)' },
  { id: 'careerRound', label: 'A career round' },
  { id: 'perfectDrive', label: 'One perfect drive' },
  { id: 'everyGoodOne', label: 'Every good one' },
];

export const handicapOptionsV2: { id: OnboardingHandicap; label: string }[] = [
  { id: 'scratch', label: 'Scratch-ish (0–5)' },
  { id: 'tidy', label: 'Pretty tidy (6–12)' },
  { id: 'gettingThere', label: 'Getting there (13–20)' },
  { id: 'learning', label: 'Still learning (21+)' },
  { id: 'noIdea', label: "No idea / don't keep one" },
];

/**
 * Vibe cards for the camera-roll aha. Music comes from the curated,
 * licensed library (lib/musicLibrary.ts — Pixabay, loudness-normalized);
 * each vibe plays its default library track. Cinematic is pre-selected
 * (default choice architecture) so the order puts it in the middle.
 */
export const vibeOptions: {
  id: ReelVibe;
  label: string;
  tagline: string;
  musicAsset: number;
}[] = [
  {
    id: 'chill',
    label: 'Chill',
    tagline: 'Easy Sunday swing',
    musicAsset: defaultTrackForVibe('chill').asset,
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    tagline: 'Telecast energy',
    musicAsset: defaultTrackForVibe('cinematic').asset,
  },
  {
    id: 'hype',
    label: 'Hype',
    tagline: 'Group-chat detonator',
    musicAsset: defaultTrackForVibe('hype').asset,
  },
];

export const vibeLabel: Record<ReelVibe, string> = {
  chill: 'Chill',
  cinematic: 'Cinematic',
  hype: 'Hype',
};
