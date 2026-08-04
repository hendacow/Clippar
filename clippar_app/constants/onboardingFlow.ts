/**
 * Data for the cold-start golfer sales funnel (feat/onboarding-flow).
 *
 * Everything content-y lives here so copy, assets and trial framing can be
 * tuned without touching screen code. Asset URLs hot-link the live marketing
 * site for now — bundle/CDN-host copies before production so app releases
 * don't depend on site changes (verified live 2026-06-14).
 */

const SITE = 'https://clippargolf.com/landing_assets';

export const flowAssets = {
  // Hero: the finished reel (tracer arc + scorecard + a made putt).
  heroReel: `${SITE}/demo_reel.mp4`,
  heroPoster: `${SITE}/steps/step1_poster.jpg`,
  // value-autocut: raw → AI-detected → clean trimmed swing.
  raw: `${SITE}/demo_raw.mp4`,
  detected: `${SITE}/demo_detected.mp4`,
  clean: `${SITE}/demo_clean.mp4`,
  // Step posters (instant placeholders, kill the black first frame).
  poster1: `${SITE}/steps/step1_poster.jpg`,
  poster2: `${SITE}/steps/step2_poster.jpg`,
  poster3: `${SITE}/steps/step3_poster.jpg`,
} as const;

export type HandicapBand = 'hitAndHope' | 'beginner' | 'mid' | 'single';
export type GolferGoal = 'brag' | 'track' | 'relive';

export const handicapOptions: { id: HandicapBand; label: string }[] = [
  { id: 'hitAndHope', label: 'Just hit and hope' },
  { id: 'beginner', label: 'Beginner (25+)' },
  { id: 'mid', label: 'Mid (15–25)' },
  { id: 'single', label: 'Single figures' },
];

export const goalOptions: { id: GolferGoal; label: string; icon: 'share' | 'chart' | 'film' }[] = [
  { id: 'brag', label: 'Brag to my mates', icon: 'share' },
  { id: 'track', label: 'Track my game', icon: 'chart' },
  { id: 'relive', label: 'Relive the good ones', icon: 'film' },
];

/** Goal-personalized lead line, echoed on value + paywall screens. */
export const goalRecap: Record<GolferGoal, string> = {
  brag: 'Unlimited reels to send the group chat',
  track: 'A permanent, filterable library of every round',
  relive: 'Your best rounds, kept forever',
};

/**
 * DELETED 2026-08-05: `Testimonial`, `testimonials` and `proofStats`.
 *
 * They held eight invented golfer reviews (fake names, @handles, star
 * ratings) and invented volume stats — `rating: 4.8`, `ratingCount: '2,140+'`
 * (attributed to the App Store), `golfers: '9,200+'`, `roundsCaptured:
 * '38,000+'`. Nothing ever imported them: the 8-screen funnel they were
 * written for (feat/onboarding-flow, proof-wall at screen 8) was superseded
 * by the live 12-screen flow, whose content module says outright "No
 * fabricated social proof — no user counts, no ratings, no testimonials until
 * real ones exist" (constants/onboardingV2.ts). So none of this ever shipped.
 *
 * Deleted rather than left sitting here, because the old comment invited
 * exactly the wrong move ("swap for real ones before launch") while
 * ONBOARDING_SALES_FLOW_SPEC.md still describes a proof-wall screen to build
 * — anyone working from that spec would have wired these straight in. Two
 * reasons that must not happen:
 *
 *  1. The rating is attributed to the App Store. Clippar has not shipped, so
 *     it cannot have 2,140+ ratings; presenting an invented App Store score
 *     in-app is an App Review problem on its own.
 *  2. The audience is Australian. Fabricated testimonials and unsubstantiated
 *     volume claims are misleading conduct under ACL s18 / s29(1)(e).
 *
 * Real social proof is welcome here once it exists and is substantiable —
 * quotes with consent, counts you can evidence. Recover the old shapes from
 * git history if useful, but never the values. tests/socialProof.test.ts
 * guards this.
 */

/**
 * Trial framing. Presentation only — the real intro offer is configured in
 * App Store Connect + RevenueCat. Toggle `enabled` off for a hard paywall.
 */
export const trialConfig = {
  enabled: true,
  days: 7,
  reminderDayBeforeBill: 2,
} as const;
