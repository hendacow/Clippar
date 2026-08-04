import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  claimableTrialDays,
  freeExitLabel,
  planPriceLine,
  purchaseCtaLabel,
  renewalDisclosure,
  trialBadgeLabel,
  trialHeadline,
  trialReassurance,
  type PaywallOffer,
} from '../lib/paywallCopy';

// The two-layer paywall: app/paywall.tsx sells at full price and says nothing
// about a trial; app/paywall-trial.tsx makes the concrete case and offers
// whatever trial the STORE confirmed, with a real way out to the free tier.
//
// Two classes of failure are worth a test each:
//  1. A trial claimed that the store never reported. lib/iap.ts sets
//     ProOffering.trialDays only for a package with a free intro offer AND an
//     eligible Apple ID; a lapsed subscriber shown "14 days free" is charged
//     the full price on the tap. That is a golfer's money and an App Review
//     3.1.2 rejection, so the copy layer is pure and tested directly.
//  2. A layer with no way out. If either layer can only lead onward to
//     paying, the app traps the people it was meant to sell to.
//
// The wiring half asserts on source text because app/ and components/ import
// react-native, which the node test runner cannot transform — same approach as
// redeemCodeWiring.test.ts and tempExportWiring.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const path = (rel: string) => join(here, '..', rel);
/**
 * Source with comments stripped. These files EXPLAIN the rules below at
 * length — "never claim a trial the store did not report", "forward to signup
 * instead of router.back()" — so a naive grep for the forbidden thing finds
 * the paragraph warning against it. Assert on the code, keep the prose.
 */
const read = (rel: string) =>
  readFileSync(path(rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const offerLayer = read('app/paywall.tsx');
const trialLayer = read('app/paywall-trial.tsx');
const kit = read('components/paywall/PaywallKit.tsx');
const rootLayout = read('app/_layout.tsx');

const monthly = (extra: Partial<PaywallOffer> = {}): PaywallOffer => ({
  plan: 'monthly',
  priceLabel: 'A$14.99',
  periodLabel: 'per month',
  ...extra,
});
const annual = (extra: Partial<PaywallOffer> = {}): PaywallOffer => ({
  plan: 'annual',
  priceLabel: 'A$99.99',
  periodLabel: 'per year',
  ...extra,
});

// ─── No layer may invent a trial ───

test('with no store-reported trial, NOTHING on either layer claims one', () => {
  for (const layer of ['offer', 'trial'] as const) {
    const offer = annual(); // trialDays absent — the store said nothing
    assert.equal(claimableTrialDays(offer, layer), null);
    assert.equal(trialBadgeLabel(offer, layer), null);
    assert.equal(trialHeadline(offer, layer), null);
    assert.equal(trialReassurance(offer, layer), null);
    assert.doesNotMatch(purchaseCtaLabel(offer, layer), /free|trial/i);
    assert.doesNotMatch(planPriceLine(offer, layer), /free|trial/i);
    assert.doesNotMatch(String(renewalDisclosure(offer, layer)), /free|trial/i);
  }
});

test('a value the store could never mean reads as no trial, not as "0 days free"', () => {
  // Defence against a provider/SDK change feeding garbage through
  // lib/iap.introTrialDays. Silence is always safe; "0 days free" is not.
  for (const days of [0, -1, 0.5, 14.5, NaN, Infinity]) {
    const offer = annual({ trialDays: days });
    assert.equal(claimableTrialDays(offer, 'trial'), null, `trialDays=${days} must not be claimable`);
    assert.doesNotMatch(purchaseCtaLabel(offer, 'trial'), /free/i);
    assert.doesNotMatch(String(renewalDisclosure(offer, 'trial')), /free trial|days free|Free for/i);
  }
});

test('a lifetime purchase can never carry a trial claim', () => {
  // A non-consumable has no introductory offer to be eligible for. If one
  // ever appears on the package, it is wrong, and claiming it would promise
  // free days against a one-off charge.
  const lifetime: PaywallOffer = {
    plan: 'lifetime',
    priceLabel: 'A$249',
    periodLabel: 'one-time',
    trialDays: 14,
  };
  assert.equal(claimableTrialDays(lifetime, 'trial'), null);
  assert.equal(purchaseCtaLabel(lifetime, 'trial'), 'Continue');
  assert.match(String(renewalDisclosure(lifetime, 'trial')), /One-time purchase of A\$249/);
  assert.match(String(renewalDisclosure(lifetime, 'trial')), /nothing renews/);
});

test('offerings still loading (null offer) claims nothing and crashes nothing', () => {
  for (const layer of ['offer', 'trial'] as const) {
    assert.equal(claimableTrialDays(null, layer), null);
    assert.equal(trialHeadline(undefined, layer), null);
    assert.equal(renewalDisclosure(null, layer), null);
    assert.equal(purchaseCtaLabel(null, layer), 'Subscribe');
  }
});

// ─── Layer 1 holds the trial back; layer 2 is the only one that offers it ───

test('layer 1 says nothing about a trial even when the store reports one', () => {
  const offer = annual({ trialDays: 14 });
  assert.equal(claimableTrialDays(offer, 'offer'), null);
  assert.equal(trialBadgeLabel(offer, 'offer'), null);
  assert.equal(trialHeadline(offer, 'offer'), null);
  assert.equal(purchaseCtaLabel(offer, 'offer'), 'Subscribe');
  assert.equal(planPriceLine(offer, 'offer'), 'A$99.99 per year');
  assert.doesNotMatch(String(renewalDisclosure(offer, 'offer')), /free|trial/i);
});

test('layer 2 offers exactly the trial the store reported — no more, no less', () => {
  for (const days of [7, 14, 30]) {
    const offer = annual({ trialDays: days });
    assert.equal(claimableTrialDays(offer, 'trial'), days);
    assert.equal(trialBadgeLabel(offer, 'trial'), `${days} days free`);
    assert.equal(purchaseCtaLabel(offer, 'trial'), `Start my ${days} days free`);
    assert.equal(planPriceLine(offer, 'trial'), `${days} days free, then A$99.99 per year`);
    assert.match(String(trialHeadline(offer, 'trial')), new RegExp(`free for ${days} days`));
    assert.match(String(renewalDisclosure(offer, 'trial')), new RegExp(`Free for ${days} days`));
  }
});

test('no layer hardcodes the founder\'s 14 days — the store\'s number is the only number', () => {
  // If "14" were baked in anywhere, a 7-day offer in App Store Connect would
  // ship as a lie without a single code change.
  const offer = annual({ trialDays: 3 });
  const rendered = [
    purchaseCtaLabel(offer, 'trial'),
    planPriceLine(offer, 'trial'),
    trialBadgeLabel(offer, 'trial'),
    trialHeadline(offer, 'trial'),
    trialReassurance(offer, 'trial'),
    renewalDisclosure(offer, 'trial'),
  ].join(' | ');
  assert.match(rendered, /3 days/);
  assert.doesNotMatch(rendered, /14/);
});

// ─── Apple's disclosures, on whichever layer sells ───

test('every subscription disclosure names the price, the period and the renewal', () => {
  const cases: Array<[PaywallOffer, 'offer' | 'trial']> = [
    [monthly(), 'offer'],
    [annual(), 'offer'],
    [monthly({ trialDays: 14 }), 'offer'],
    [monthly(), 'trial'],
    [annual({ trialDays: 14 }), 'trial'],
  ];
  for (const [offer, layer] of cases) {
    const text = String(renewalDisclosure(offer, layer));
    assert.ok(text.includes(offer.priceLabel), `${layer} disclosure must show the store price`);
    assert.ok(text.includes(offer.periodLabel), `${layer} disclosure must show the billing period`);
    assert.match(text, /automatically renews/);
    assert.match(text, /24 hours before the end of the current period/);
    assert.match(text, /Apple Account Settings/);
  }
});

test('layer 1 does not promise an immediate charge to someone the store will give a trial', () => {
  // Layer 1 stays silent about the trial — which is a marketing choice, not a
  // licence to be wrong. "Charged at confirmation of purchase" is the false
  // sentence for a trial-eligible golfer, so it only appears when the store
  // reported no intro offer at all.
  const eligible = String(renewalDisclosure(annual({ trialDays: 14 }), 'offer'));
  assert.doesNotMatch(eligible, /at confirmation of purchase/);
  assert.match(eligible, /when your subscription starts/);

  const noOffer = String(renewalDisclosure(annual(), 'offer'));
  assert.match(noOffer, /Payment is charged to your Apple ID at confirmation of purchase/);
});

test('the trial disclosure says when the money moves and how to stop it', () => {
  const text = String(renewalDisclosure(annual({ trialDays: 14 }), 'trial'));
  assert.match(text, /at the end of the free trial unless you cancel/);
  assert.match(String(trialReassurance(annual({ trialDays: 14 }), 'trial')), /Cancel any time/);
  // We do not send a pre-billing reminder, so we must not imply one.
  assert.doesNotMatch(text, /remind/i);
  assert.doesNotMatch(String(trialReassurance(annual({ trialDays: 14 }), 'trial')), /remind/i);
});

// ─── Both layers have a way out ───

test('each layer has a labelled exit, and neither is a shrug', () => {
  assert.equal(freeExitLabel('offer'), 'Continue to free');
  assert.equal(freeExitLabel('trial'), 'Continue with the free plan');
  for (const layer of ['offer', 'trial'] as const) {
    assert.ok(freeExitLabel(layer).length >= 10, 'the exit must be a sentence, not an "x"');
  }
});

test('the exit link is legible: theme text colour, full opacity, 44pt target', () => {
  // What gets an app rejected under 3.1.2 is a dismiss path that is hard to
  // find or invisible against its background. One component renders the exit
  // on both layers, so these properties are checked once.
  const link = kit.slice(kit.indexOf('export function ContinueFreeLink'));
  assert.match(link, /color: theme\.colors\.textSecondary/, 'a real text colour, never a tint of the background');
  assert.doesNotMatch(link, /textTertiary/, 'textTertiary (#5A5A72) is ~2.9:1 on #0A0A0F — too faint for the exit');
  assert.doesNotMatch(link, /opacity/, 'no faded-out exit');
  assert.match(link, /minHeight: 44/);
  assert.match(link, /minWidth: 44/);
  assert.match(link, /hitSlop/);
});

test('both layers render the exit OUTSIDE the scroll view', () => {
  // Below-the-fold is the practical version of "hard to find": on the
  // smallest phone the link has to be on screen at the first frame.
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer]] as const) {
    const linkAt = src.indexOf('<ContinueFreeLink');
    const scrollEndAt = src.indexOf('</ScrollView>');
    assert.notEqual(linkAt, -1, `${name} must render the exit link`);
    assert.notEqual(scrollEndAt, -1);
    assert.ok(linkAt > scrollEndAt, `${name} must render the exit after the scroll view closes`);
  }
});

test('layer 1 exits to layer 2, and layer 2 exits to the free tier', () => {
  assert.match(
    offerLayer,
    /router\.replace\(\s*fromOnboarding[\s\S]{0,160}?'\/paywall-trial'/,
    'layer 1 "Continue to free" must open layer 2, carrying ?from through'
  );
  assert.match(offerLayer, /label=\{freeExitLabel\(LAYER\)\}\s+onPress=\{continueToFree\}/);
  // Layer 2's is terminal: straight to the shared exit, nothing further to
  // sell. A third sales layer here would be the trap 3.1.2 forbids.
  assert.match(trialLayer, /label=\{freeExitLabel\(LAYER\)\}\s+onPress=\{exit\}/);
  assert.doesNotMatch(trialLayer, /paywall-trial'|'\/paywall'/, 'layer 2 must not route back into the funnel');
});

// ─── The forward-only exit contract ───

test('the exit contract lives in one place and continues forward from onboarding', () => {
  assert.match(kit, /export function usePaywallExit/);
  assert.match(
    kit,
    /if \(fromOnboarding\) router\.replace\('\/\(auth\)\/signup'\);\s*else router\.back\(\);/,
    'from the pre-signup funnel every terminal action goes forward to signup'
  );
});

test('neither layer grows its own router.back()', () => {
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer]] as const) {
    assert.doesNotMatch(src, /router\.back\(\)/, `${name} must exit through usePaywallExit, not directly`);
    assert.match(src, /usePaywallExit\(from\)/, `${name} must use the shared exit`);
  }
});

test('purchase and restore both run the exit, on both layers', () => {
  // A purchase that leaves the golfer staring at the paywall they just paid
  // on is the same dead-end as a missing close button.
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer]] as const) {
    assert.match(src, /usePaywallCommerce\(\{ onDone: exit \}\)/, `${name} must hand its exit to the commerce hook`);
  }
  const purchase = kit.slice(kit.indexOf('const handlePurchase'), kit.indexOf('const handleRestore'));
  assert.match(purchase, /await iap\.purchase\(selected\)/);
  assert.match(purchase, /emitSubscriptionChanged\(\)/);
  assert.match(purchase, /onDone\(\)/);
  const restore = kit.slice(kit.indexOf('const handleRestore'));
  assert.match(restore, /await iap\.restore\(\)/);
  assert.match(restore, /if \(restored\) onDone\(\)/);
});

// ─── Reachability + required fixtures ───

test('layer 2 exists at the route layer 1 sends people to', () => {
  assert.ok(existsSync(path('app/paywall-trial.tsx')), 'expo-router resolves /paywall-trial from app/paywall-trial.tsx');
  assert.match(trialLayer, /export default function PaywallTrialScreen/);
});

test('a signed-out golfer is not bounced off layer 2', () => {
  // The auth gate in app/_layout.tsx replaces signed-out users onto login.
  // The onboarding funnel reaches BOTH layers before an account exists, so
  // both segments must be exempt or layer 2 is dead on arrival.
  assert.match(
    rootLayout,
    /const onPaywall =[\s\S]{0,120}?segments\[0\] === 'paywall-trial'/,
    "app/_layout.tsx must exempt 'paywall-trial' from the signed-out redirect"
  );
});

test('Restore Purchases, Terms and Privacy appear on every layer that sells', () => {
  assert.match(kit, /Restore Purchases/);
  assert.match(kit, /https:\/\/clippargolf\.com\/terms/);
  assert.match(kit, /https:\/\/clippargolf\.com\/privacy/);
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer]] as const) {
    assert.match(src, /<PaywallFixtures onRestore=\{handleRestore\}/, `${name} must render the required fixtures`);
    assert.match(src, /<PurchaseDisclosure text=\{renewalDisclosure\(selectedOffering, LAYER\)\}/, `${name} sells, so it discloses`);
  }
});

// ─── The screens must not re-implement any of the above ───

test('the screens ask lib/paywallCopy instead of reading trialDays themselves', () => {
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer], ['the kit', kit]] as const) {
    assert.doesNotMatch(src, /trialDays/, `${name} must not read the store field directly`);
    assert.doesNotMatch(src, /\d+\s*days?\s*free/i, `${name} must not spell a trial length in JSX`);
  }
});

test('each screen declares which layer it is, exactly once', () => {
  assert.match(offerLayer, /const LAYER: PaywallLayer = 'offer';/);
  assert.match(trialLayer, /const LAYER: PaywallLayer = 'trial';/);
  // Layer 1 asking for 'trial' copy anywhere would undo the whole split.
  assert.equal(offerLayer.match(/'trial'/g), null);
});

test('prices are still read from the offering, never from a constant', () => {
  for (const [name, src] of [['layer 1', offerLayer], ['layer 2', trialLayer], ['the kit', kit]] as const) {
    assert.doesNotMatch(src, /A\$\d/, `${name} must not hardcode a price`);
    assert.doesNotMatch(src, /monthlyPriceAud|annualPriceAud/, `${name} must not read the placeholder prices`);
  }
  assert.match(kit, /planPriceLine\(o, layer\)/, 'the plan card renders the store price line');
});
