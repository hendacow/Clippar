import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Redemption runs through Apple's Offer Codes, not a code table of ours.
//
// The bespoke CLIP-xxxx scheme (migration 018 + the redeem-code function) was
// retired on 2026-08-04: App Review 3.1.1 prohibits unlocking features with a
// developer's own license keys, and a text box that turns a string into paid
// functionality is the shape the rule names. Henry's call — not worth finding
// out on a first submission.
//
// These pin the parts the implementation cannot check about itself: that the
// screen is REACHABLE, that it hands off to StoreKit rather than to us, that
// the poll can actually observe a grant, and that the retired server side
// stays retired. The 3.1.1 regression is the one that matters — it is a single
// <TextInput> away from coming back, and it would come back looking helpful.
//
// These assert on source text because app/ and lib/ import react-native, which
// the node test runner cannot transform — same approach as
// tempExportWiring.test.ts and privacyManifest.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const path = (rel: string) => join(here, '..', rel);
const read = (rel: string) => readFileSync(path(rel), 'utf8');

/**
 * Source with comments removed. Several assertions below are of the form
 * "this file must never mention X" — and the comment explaining WHY X is
 * banned necessarily mentions X. Strip prose so the guard tests what the
 * code does, not what the docs say.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const REDEEM_ROUTE = '/profile/redeem';

const screen = read('app/profile/redeem.tsx');
const paywall = read('app/paywall.tsx');
const profileTab = read('app/(tabs)/profile.tsx');
const subscription = read('lib/subscription.ts');
const config = read('constants/config.ts');
const iap = read('lib/iap.ts');

// ─── Reachability ───

test('the redeem screen exists at the route both entry points push', () => {
  assert.ok(
    existsSync(path('app/profile/redeem.tsx')),
    'expo-router resolves /profile/redeem from app/profile/redeem.tsx'
  );
  assert.match(screen, /export default function RedeemCodeScreen/);
});

test('the Profile tab has a row that opens it', () => {
  assert.match(
    profileTab,
    new RegExp(`router\\.push\\('${REDEEM_ROUTE}'\\)`),
    'app/(tabs)/profile.tsx must navigate to the redeem screen'
  );
  assert.match(profileTab, /title="Redeem a code"/);
});

test('the paywall offers a code path without competing with the purchase CTA', () => {
  assert.match(
    paywall,
    new RegExp(`router\\.push\\('${REDEEM_ROUTE}'\\)`),
    'app/paywall.tsx must offer a way to reach the redeem screen'
  );
  assert.match(paywall, /Have a code\?/);

  // App Review 3.1.1 wants StoreKit to be the prominent way to buy. The link
  // must sit BELOW the purchase button and must not be a <Button>.
  const ctaAt = paywall.indexOf('onPress={handlePurchase}');
  const linkAt = paywall.indexOf('Have a code?');
  assert.notEqual(ctaAt, -1, 'expected the purchase CTA in app/paywall.tsx');
  assert.notEqual(linkAt, -1);
  assert.ok(ctaAt < linkAt, 'the code link must come after the purchase CTA, not before it');
  const linkBlock = paywall.slice(linkAt - 600, linkAt + 200);
  assert.doesNotMatch(
    linkBlock,
    /<Button/,
    'the code affordance must be a text link, not a second call-to-action button'
  );
});

test('the paywall hides the code link in the pre-signup funnel', () => {
  // ?from=onboarding opens the paywall before the account exists. An offer
  // code attaches to an Apple ID and the resulting entitlement is aliased to
  // the Supabase user, so redeeming before signup strands the grant.
  assert.match(paywall, /\{!fromOnboarding \? \(/);
});

// ─── 3.1.1: the entitlement must come from StoreKit, not from us ───

test('the screen hands off to StoreKit and has no code field of its own', () => {
  assert.match(
    screen,
    /await iap\.presentCodeRedemption\(\)/,
    'the screen must present Apple’s redemption sheet'
  );
  // The regression guard. Any of these coming back means someone rebuilt the
  // 3.1.1 exposure — a field that accepts a developer-issued key.
  assert.doesNotMatch(screen, /<TextInput/, 'no code entry field may return to this screen');
  assert.doesNotMatch(screen, /autoCapitalize/, 'a code field would need this — there must be none');
  assert.doesNotMatch(
    screen,
    /functions\.invoke/,
    'redemption must not call any endpoint of ours; Apple validates the code'
  );
  assert.doesNotMatch(
    screen,
    /from '@\/lib\/redeemCode'/,
    'the bespoke redemption client is retired and must not be re-imported'
  );
});

test('the retired bespoke redemption client is actually gone', () => {
  // Leaving it importable is how it comes back: the module still compiles, so
  // the shortest fix for any redemption complaint is to wire it up again.
  assert.ok(
    !existsSync(path('lib/redeemCode.ts')),
    'lib/redeemCode.ts must be deleted, not merely unreferenced'
  );
});

test('the retired server side is marked so nobody applies or deploys it', () => {
  // Both are on disk for their design notes. Neither has ever touched a
  // database, and applying 018 re-introduces the guideline exposure.
  // supabase/retired/, NOT supabase/migrations/ — living in the migrations
  // directory meant `supabase db push` applied it despite the header, which is
  // exactly the exposure the header warns about. The path is the enforcement;
  // the header is only the explanation.
  assert.ok(
    !existsSync(path('supabase/migrations/018_redemption_codes.sql')),
    '018 must not sit in the push path — a DO-NOT-APPLY header does not stop db push'
  );
  const migration = read('supabase/retired/018_redemption_codes.sql');
  const fn = read('supabase/functions/redeem-code/index.ts');
  assert.match(migration, /SUPERSEDED\s*—\s*DO NOT APPLY/i);
  assert.match(fn, /SUPERSEDED\s*—\s*DO NOT DEPLOY/i);
});

// ─── The handoff has to be able to observe a grant ───

// Both providers implement presentCodeRedemption and the stub is declared
// first, so anchoring on the method name alone slices from the WRONG one — and
// the ordering assertions below would then read Purchases calls belonging to
// isProActive() and hasActiveStoreSubscription().
const rcRedemption = (() => {
  const providerAt = iap.indexOf('const RevenueCatProvider');
  assert.notEqual(providerAt, -1, 'expected a RevenueCatProvider in lib/iap.ts');
  const methodAt = iap.indexOf('async presentCodeRedemption', providerAt);
  assert.notEqual(methodAt, -1, 'RevenueCatProvider must implement presentCodeRedemption');
  return iap.slice(methodAt);
})();

test('the poll invalidates the cached CustomerInfo before each read', () => {
  // getCustomerInfo serves a cache for minutes. Without invalidation the loop
  // re-reads the same pre-redemption snapshot ten times and always concludes
  // 'dismissed' — the feature would look broken for every valid code.
  const invalidateAt = rcRedemption.indexOf('invalidateCustomerInfoCache()');
  const readAt = rcRedemption.indexOf('Purchases.getCustomerInfo()');
  assert.notEqual(invalidateAt, -1, 'the poll must invalidate the CustomerInfo cache');
  assert.ok(invalidateAt < readAt, 'invalidation must precede the read, not follow it');
});

test('the sheet is presented through the SDK, not reimplemented', () => {
  assert.match(iap, /Purchases\.presentCodeRedemptionSheet\(\)/);
});

test('an existing subscriber is never told a code activated something', () => {
  // presentCodeRedemptionSheet resolves when the sheet is SHOWN, so a user who
  // already holds Pro and backs straight out would otherwise poll, see Pro on,
  // and be congratulated for redeeming nothing.
  const snapshotAt = rcRedemption.indexOf('const alreadyPro');
  const presentAt = rcRedemption.indexOf('presentCodeRedemptionSheet()');
  assert.notEqual(snapshotAt, -1, 'the pre-redemption Pro snapshot must exist');
  assert.ok(snapshotAt < presentAt, 'the snapshot must be taken BEFORE the sheet is presented');
  assert.match(rcRedemption, /if \(alreadyPro\) return \{ status: 'dismissed' \};/);
});

test('a successful redemption refreshes Pro state across the app', () => {
  const emitAt = rcRedemption.indexOf('emitSubscriptionChanged()');
  const activatedAt = rcRedemption.indexOf("return { status: 'activated' }");
  assert.notEqual(emitAt, -1, 'activation must emit on the subscription bus');
  assert.ok(emitAt < activatedAt, 'the emit must run in the activated branch, before returning');
});

test('the bus it emits on is the one useSubscription listens to', () => {
  assert.match(read('lib/subscriptionEvents.ts'), /export function emitSubscriptionChanged/);
  assert.match(read('hooks/useSubscription.ts'), /onSubscriptionChanged\(refresh\)/);
});

test('a double tap cannot stack two redemption sheets', () => {
  // The guard has to be synchronous. Two taps in the same React batch both
  // read the stale `busy === false` out of their closure, so `busy` alone is
  // not a lock — a ref flips on the first tap.
  assert.match(screen, /inFlight = useRef\(false\)/);
  assert.match(screen, /if \(inFlight\.current\) return;/);
  const guardAt = screen.indexOf('inFlight.current = true;');
  const awaitAt = screen.indexOf('await iap.presentCodeRedemption()');
  assert.ok(guardAt !== -1 && awaitAt > guardAt, 'the guard must close before the sheet opens');
  assert.match(screen, /disabled=\{busy\}/);
});

test('a dismissed sheet is never reported as a failed code', () => {
  // StoreKit reports nothing about what was typed, and Apple's receipt can
  // land after the poll gives up. Telling someone their valid code failed,
  // seconds before it works, is the one outcome worth engineering against.
  assert.match(screen, /case 'dismissed':/);
  const start = screen.indexOf("case 'dismissed':");
  const block = screen.slice(start, screen.indexOf("case 'unavailable':"));
  assert.doesNotMatch(block, /invalid|not valid|failed|incorrect|wrong/i);
});

test('the stub build says why rather than claiming a grant', () => {
  const stubStart = iap.indexOf('const StubProvider');
  const stubEnd = iap.indexOf('const RevenueCatProvider');
  const stub = iap.slice(stubStart, stubEnd);
  assert.match(stub, /presentCodeRedemption/);
  assert.match(stub, /status: 'unavailable'/);
  assert.doesNotMatch(stub, /status: 'activated'/, 'the stub must never report an activation');
});

test('the screen claims no free trial', () => {
  // lib/iap.ts:ProOffering.trialDays only claims a trial the store reported,
  // because promising one to an ineligible lapsed subscriber charges them
  // immediately (App Review 3.1.2 + real money). Nothing here may reintroduce
  // the claim.
  assert.doesNotMatch(screen, /free trial|days free/i);
});

// ─── The entitlement gate this feature rides on ───

test('an active status with no expiry still reads as lifetime', () => {
  // Offer codes are the ordinary path now, but a manually comped account is
  // still exactly profiles.subscription_status = 'active' with a NULL expiry —
  // including the demo account handed to App Review. If this branch ever moves
  // below the date comparison, `new Date(null) > new Date()` is false and the
  // reviewer's account silently loses Pro.
  assert.match(
    subscription,
    /if \(!profile\.subscription_expires_at\) return true;/,
    'lib/subscription.ts must treat a null expiry on an active status as lifetime'
  );
  const nullCheckAt = subscription.indexOf('if (!profile.subscription_expires_at) return true;');
  const dateCompareAt = subscription.indexOf('new Date(profile.subscription_expires_at) >');
  assert.notEqual(dateCompareAt, -1);
  assert.ok(nullCheckAt < dateCompareAt, 'the null-expiry branch must come first');
});

test('a false RevenueCat entitlement does not shadow a server-side grant', () => {
  // A comped user has no StoreKit purchase, so isProActive() is false for
  // them. Only a TRUE may short-circuit; a false has to fall through to the
  // Supabase profile read or the comp never unlocks anything.
  assert.match(subscription, /if \(await iap\.isProActive\(\)\) return true;/);
  const storeAt = subscription.indexOf('iap.isProActive()');
  const profileAt = subscription.indexOf(".from('profiles')");
  assert.ok(storeAt < profileAt, 'the profile read must still follow the store check');
});

test('"couldn\'t determine" still throws instead of returning false', () => {
  // Collapsing indeterminate into false locks paying users out on a flaky
  // connection AND poisons the offline cache with a false negative.
  assert.match(subscription, /subscription check indeterminate/);
  assert.match(
    subscription,
    /catch \{\s*const cached = /,
    'getProStatus must answer an indeterminate check from the cache, not from false'
  );
});

// ─── Pricing ───

test('no placeholder prices exist anywhere in config', () => {
  // They used to. The stub rendered them as real prices, which meant a user
  // on any non-AU storefront saw Australian dollars for a product Apple would
  // charge them in their own currency — an App Review 3.1.2 problem, and real
  // money harm if they bought. Hardcoded prices also drift from App Store
  // Connect in silence.
  assert.doesNotMatch(
    codeOnly(config),
    /monthlyPriceAud|annualPriceAud/,
    'placeholder prices must never come back — the store is the only price source'
  );
});

test('the stub offers nothing rather than inventing a price', () => {
  const stubStart = iap.indexOf('const StubProvider');
  const stubEnd = iap.indexOf('const RevenueCatProvider');
  assert.ok(stubStart !== -1 && stubEnd > stubStart);
  const stub = iap.slice(stubStart, stubEnd);

  // The stub runs whenever StoreKit is unreachable, and in that state we do
  // not know the user's storefront. An empty list is the only honest answer.
  assert.match(
    stub,
    /async getOfferings\(\): Promise<ProOffering\[\]> \{\s*return \[\];\s*\},/,
    'StubProvider.getOfferings must return [] — never a fabricated offering'
  );
  const stubCode = codeOnly(stub);
  assert.doesNotMatch(stubCode, /priceLabel:/, 'the stub must not set a price label at all');
  assert.doesNotMatch(stubCode, /A\$/, 'the stub must not format a currency string');
});

test('prices are only ever the store-reported priceString', () => {
  const rcProvider = iap.slice(iap.indexOf('const RevenueCatProvider'));
  assert.match(rcProvider, /priceLabel: pkg\.product\.priceString/);
  // The savings badge must be derived from the same store prices, never from
  // constants — otherwise the discount claim can contradict the real pair.
  assert.match(
    rcProvider,
    /pkg\.product\.price \/ \(monthly\.product\.price \* 12\)/,
    'the "Save N%" badge must be computed from store prices'
  );
});

test('the paywall distinguishes loading from unavailable', () => {
  // An empty offerings list used to render a spinner forever. Now that the
  // stub returns empty by design, that state is reachable in production and
  // has to say something true.
  const kit = read('components/paywall/PaywallKit.tsx');
  assert.match(kit, /offeringsLoaded/, 'the commerce hook must expose a loaded flag');
  for (const screen of ['app/paywall.tsx', 'app/paywall-trial.tsx']) {
    const src = read(screen);
    assert.match(src, /offeringsLoaded/, `${screen} must distinguish loading from unavailable`);
    assert.match(
      src,
      /isn&apos;t available right now/,
      `${screen} must tell the user Pro is unavailable instead of spinning`
    );
  }
});
