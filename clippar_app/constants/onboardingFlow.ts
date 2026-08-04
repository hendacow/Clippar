/**
 * Data for the cold-start golfer sales funnel (feat/onboarding-flow).
 *
 * Everything content-y lives here so copy, assets, testimonials and trial
 * framing can be tuned without touching screen code. Asset URLs hot-link the
 * live marketing site for now — bundle/CDN-host copies before production so
 * app releases don't depend on site changes (verified live 2026-06-14).
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

export interface Testimonial {
  name: string;
  handle: string;
  stars: number;
  quote: string;
}

/**
 * PLACEHOLDER reviews — believable Aussie amateurs, swap for real ones
 * before launch. (Marked clearly so they're never mistaken for verified.)
 *
 * No quote may describe a feature the shipping build doesn't have. Two of
 * these sold the shot tracer while config.tracer.enabled is false, which is
 * the same App Review 3.1.2 misrepresentation as listing it on the paywall —
 * they're reworded onto capabilities that actually ship (auto-trim, the
 * scorecard overlay, sharing). If the tracer flag is ever flipped on, tracer
 * quotes can come back; until then, keep them out.
 */
export const testimonials: Testimonial[] = [
  { name: 'Dave M.', handle: '@dave_plays_off_18', stars: 5, quote: "Sent my mates a reel of the only par I made all day. The group chat hasn't recovered." },
  { name: 'Steph K.', handle: '@steph.swings', stars: 5, quote: 'Showed my dad the reel from Sunday and he didn’t believe it was the same course I always whinge about.' },
  { name: 'Jase T.', handle: '@weekend_hacker_jase', stars: 4, quote: "Clip on the buggy mount, hit go, forget about it. Reel's ready by the time I'm at the 19th." },
  { name: 'Priya R.', handle: '@priya.golfs', stars: 5, quote: 'Was sceptical about the AI trimming but it nails the swing every single time. Cut my chunked wedges out for me too.' },
  { name: 'Macca B.', handle: '@macca_2under_dreaming', stars: 5, quote: 'Pennant comp, signature hole, 6 iron to a foot. Having that on a reel forever is worth more than the green fee.' },
  { name: 'Tara N.', handle: '@tara.tee.time', stars: 4, quote: 'My handicap hasn’t budged but my Instagram has never looked better. Sunday foursome are all on it now.' },
  { name: 'Robbo', handle: '@robbo_golf_gc', stars: 5, quote: 'Did a 36-hole day at Barnbougle and got two clean reels off one battery. The scorecard overlay sells it.' },
  { name: 'Liam H.', handle: '@liamh.golf', stars: 5, quote: 'The clicker means I never touch the phone mid-round. Set and forget.' },
];

export const proofStats = {
  rating: 4.8,
  ratingCount: '2,140+',
  golfers: '9,200+',
  roundsCaptured: '38,000+',
} as const;

/**
 * Trial framing. Presentation only — the real intro offer is configured in
 * App Store Connect + RevenueCat. Toggle `enabled` off for a hard paywall.
 */
export const trialConfig = {
  enabled: true,
  days: 7,
  reminderDayBeforeBill: 2,
} as const;
