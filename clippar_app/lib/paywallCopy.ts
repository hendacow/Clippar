/**
 * Every word the two paywall layers say about price, trials and renewal —
 * PURE (no imports, no native modules) so the rules that keep us out of App
 * Review 3.1.2 trouble are unit-testable under `node --test`
 * (tests/paywallLayers.test.ts).
 *
 * Clippar sells Pro across two layers (funnel contract in app/paywall.tsx):
 *
 *   'offer' — LAYER 1, app/paywall.tsx. The paid offer, monthly + annual, at
 *             full price. It says NOTHING about a free trial even when the
 *             store reports one: the trial is deliberately held back as the
 *             second-chance offer for people who take the exit.
 *   'trial' — LAYER 2, app/paywall-trial.tsx, reached from layer 1's
 *             "Continue to free". Spells out what Pro actually does, then
 *             offers the trial. The ONLY layer allowed to claim one.
 *
 * THE RULE EVERY FUNCTION HERE ENFORCES: a trial claim comes from the
 * store-reported `trialDays` or it is not made. lib/iap.ts sets that field
 * only when the package carries a free introductory offer AND the Apple ID
 * is not known-ineligible for it. A hardcoded "14 days free" shown to a
 * lapsed subscriber charges them the full price the moment they tap — real
 * money out of a golfer's account, and a 3.1.2 rejection on top. The screens
 * therefore never read `trialDays` directly; they ask these functions.
 *
 * Prices are equally never hardcoded: `priceLabel` is the store-localised
 * priceString (or, on unconfigured builds, the config placeholder), and it is
 * simply passed through.
 */

export type PaywallLayer = 'offer' | 'trial';
export type PaywallPlan = 'monthly' | 'annual' | 'lifetime';

/**
 * Structurally compatible with lib/iap.ts ProOffering — declared locally so
 * this module stays import-free and node can run it without a bundler.
 */
export interface PaywallOffer {
  plan: PaywallPlan;
  /** Store-localised display price, e.g. "A$99.99". */
  priceLabel: string;
  /** "per month" / "per year" / "one-time". */
  periodLabel: string;
  /** Free intro-offer length in days, present only when the store said so. */
  trialDays?: number;
}

/** The sentence Apple requires next to any auto-renewing purchase. */
const AUTO_RENEW =
  'The subscription automatically renews unless auto-renew is turned off at least 24 hours before the end of the current period. Manage or cancel anytime in your Apple Account Settings.';

/**
 * How many days of free trial THIS layer may claim, or null for "say nothing
 * about a trial".
 *
 * Three ways to get null, and all three matter:
 *  - layer 1 always: it is the full-price offer by design.
 *  - no store-reported trial (or an ineligible user): claiming one would be
 *    the lie that charges someone.
 *  - a nonsense value (0, -1, 12.5, NaN) arriving from a provider change:
 *    "0 days free" is worse than silence, so garbage reads as no trial.
 * Lifetime is a non-consumable and cannot carry an intro trial at all.
 */
export function claimableTrialDays(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): number | null {
  if (!offer || layer !== 'trial' || offer.plan === 'lifetime') return null;
  const days = offer.trialDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) return null;
  return days;
}

/** Text on the purchase button. Callers own the busy/loading state. */
export function purchaseCtaLabel(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): string {
  const days = claimableTrialDays(offer, layer);
  if (days) return `Start my ${days} days free`;
  if (offer?.plan === 'lifetime') return 'Continue';
  return 'Subscribe';
}

/** Sub-line under a plan card: "A$99.99 per year", trial-aware on layer 2. */
export function planPriceLine(offer: PaywallOffer, layer: PaywallLayer): string {
  const days = claimableTrialDays(offer, layer);
  const price = `${offer.priceLabel} ${offer.periodLabel}`;
  return days ? `${days} days free, then ${price}` : price;
}

/** Badge on a plan card, or null when this layer claims no trial. */
export function trialBadgeLabel(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): string | null {
  const days = claimableTrialDays(offer, layer);
  return days ? `${days} days free` : null;
}

/** Layer 2's headline over the trial offer, or null when there is no trial
 *  to offer (the layer still sells — it just sells at full price). */
export function trialHeadline(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): string | null {
  const days = claimableTrialDays(offer, layer);
  return days ? `Try all of it free for ${days} days` : null;
}

/** Layer 2's reassurance line under the trial headline, or null. */
export function trialReassurance(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): string | null {
  const days = claimableTrialDays(offer, layer);
  if (!days) return null;
  // Deliberately NOT "we'll remind you before you're charged" (the shape of
  // components/onboarding/sales/primitives.tsx TrialTimeline): Clippar sends
  // no such reminder, and a promise the app does not keep is the same 3.1.2
  // misrepresentation as a fake trial. What we can promise is where the off
  // switch is.
  return `Cancel any time in your Apple Account Settings before day ${days} and you are not charged.`;
}

/**
 * The auto-renewal / billing disclosure Apple requires on whichever layer
 * offers a purchase (Guideline 3.1.2). Null only while offerings load.
 *
 * Three shapes, and the middle one is the subtle one:
 *  1. lifetime — one-time charge, nothing renews.
 *  2. a trial CLAIMED on this layer — say when the free days end and what
 *     happens then.
 *  3. no trial claimed — which is NOT the same as no trial existing. Layer 1
 *     stays silent about a trial the StoreKit sheet may still apply, so it
 *     must not assert a charge "at confirmation of purchase" either: that
 *     sentence is the false one for a trial-eligible golfer. "When your
 *     subscription starts" is true both ways. Only when the store reports no
 *     intro offer at all do we state the immediate charge outright.
 */
export function renewalDisclosure(
  offer: PaywallOffer | null | undefined,
  layer: PaywallLayer
): string | null {
  if (!offer) return null;
  if (offer.plan === 'lifetime') {
    return `One-time purchase of ${offer.priceLabel}. Payment is charged to your Apple ID at confirmation of purchase. No subscription, nothing renews.`;
  }
  const price = `${offer.priceLabel} ${offer.periodLabel}`;
  const days = claimableTrialDays(offer, layer);
  if (days) {
    return `Free for ${days} days, then ${price}. Payment is charged to your Apple ID at the end of the free trial unless you cancel at least 24 hours before it ends. ${AUTO_RENEW}`;
  }
  if (offer.trialDays) {
    return `${price}, billed to your Apple ID when your subscription starts. ${AUTO_RENEW}`;
  }
  return `${price}. Payment is charged to your Apple ID at confirmation of purchase. ${AUTO_RENEW}`;
}

/**
 * The way out of each layer, in plain words.
 *
 * Layer 1's exit is a navigation (it opens layer 2, one tap from free);
 * layer 2's exit is the real thing and leaves the paid funnel entirely. Both
 * strings live here so a future edit that quietly softens one into "Maybe
 * later" — or deletes it — trips tests/paywallLayers.test.ts instead of App
 * Review.
 */
export function freeExitLabel(layer: PaywallLayer): string {
  return layer === 'offer' ? 'Continue to free' : 'Continue with the free plan';
}
