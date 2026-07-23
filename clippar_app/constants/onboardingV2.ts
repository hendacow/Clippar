/**
 * Content for the 12-screen animated onboarding (feat/onboarding-v2).
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
  OnboardingAgeRange,
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
  { id: 'plus', label: 'Plus (take a bow)' },
  { id: 'scratch', label: 'Scratch-ish (0–5)' },
  { id: 'tidy', label: 'Pretty tidy (6–12)' },
  { id: 'gettingThere', label: 'Getting there (13–20)' },
  { id: 'learning', label: 'Still learning (21+)' },
  { id: 'noIdea', label: "No idea / don't keep one" },
];

export const ageRangeOptions: { id: OnboardingAgeRange; label: string }[] = [
  { id: 'under18', label: 'Under 18' },
  { id: '18to29', label: '18–29' },
  { id: '30to44', label: '30–44' },
  { id: '45to59', label: '45–59' },
  { id: '60plus', label: '60+' },
];

/** Screen 8 — age range (skippable). The sub carries the joke. */
export const ageScreenCopy = {
  title: 'Roughly how old are you?',
  sub: 'So we know if your reel wants bass drops or the Sunday-telecast piano.',
  skip: "Skip — age is a mindset",
};

/**
 * Screen 2 — the problem. Lands the real pains: shots never filmed, footage
 * buried in the camera roll, nobody edits after a round, nothing makes the
 * group chat.
 */
export const problemCopy = {
  title: 'Your best shots are disappearing.',
  sub: 'The ones that got filmed are buried in your camera roll — because nobody edits golf footage after a round.',
  rows: [
    { label: 'The chip-in at the 9th', detail: '3 summers ago · never filmed' },
    { label: 'That drive that split the fairway', detail: 'buried deep in the camera roll' },
    { label: 'The putt for the career round', detail: 'never made it to the group chat' },
  ],
  cta: "Let's fix that",
};

/**
 * Screen 3 — how Clippar works. Education only: plants the mental model of
 * the full setup (phone mount on the bag/buggy + Bluetooth clicker) without
 * any price, link or purchase CTA — and without ever implying the hardware
 * is required. The note keeps the hand-held / mate-films path first-class.
 */
export const howItWorksCopy = {
  title: "Here's how Clippar works.",
  sub: 'Set up once at the first tee — walk off the 18th with the reel already cut.',
  steps: [
    {
      title: 'Mount & play',
      detail:
        'Clip your phone to your bag or buggy, then tap the clicker before and after each shot.',
    },
    {
      title: 'AI does the editing',
      detail: 'Every swing found and trimmed in seconds — no scrubbing through footage.',
    },
    {
      title: 'Share the reel',
      detail: 'One tap to the group chat or your socials.',
    },
  ],
  note: 'No mount or clicker handy? Film by hand or get a mate on camera — Clippar edits it all the same.',
  cta: 'Too easy',
};

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
