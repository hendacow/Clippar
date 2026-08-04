import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// redeemCode.test.ts pins the logic. These pin the parts the logic cannot
// check about itself: that the screen is REACHABLE, that redeeming actually
// refreshes Pro state, that no user id rides in the request body, and that the
// entitlement gate the whole feature depends on has not drifted.
//
// A redeem screen nobody can open, or a grant the UI never notices, reads as
// done and is not.
//
// These assert on source text because app/ and lib/ import react-native, which
// the node test runner cannot transform — same approach as
// tempExportWiring.test.ts and privacyManifest.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const path = (rel: string) => join(here, '..', rel);
const read = (rel: string) => readFileSync(path(rel), 'utf8');

const REDEEM_ROUTE = '/profile/redeem';

const screen = read('app/profile/redeem.tsx');
const lib = read('lib/redeemCode.ts');
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
  // ?from=onboarding opens the paywall before the account exists. A code
  // attaches to an account, so the link could only lead to "Sign in first".
  assert.match(paywall, /\{!fromOnboarding \? \(/);
});

// ─── The screen does the two things that make a grant visible ───

test('the screen calls redeemCode and refreshes Pro state on success', () => {
  assert.match(screen, /await redeemCode\(code\)/, 'the screen must actually call redeemCode');
  assert.match(
    screen,
    /emitSubscriptionChanged\(\)/,
    'a successful redemption must emit on the subscription bus, as app/paywall.tsx does after a purchase'
  );
  // The emit must be INSIDE the success branch — emitting unconditionally
  // would fire a pointless refresh on every failed attempt.
  const successAt = screen.indexOf("outcome.status === 'redeemed'");
  const emitAt = screen.indexOf('emitSubscriptionChanged()');
  assert.notEqual(successAt, -1, 'expected a success branch in app/profile/redeem.tsx');
  assert.ok(successAt < emitAt, 'emitSubscriptionChanged must run inside the success branch');
});

test('the bus the screen emits on is the one useSubscription listens to', () => {
  const events = read('lib/subscriptionEvents.ts');
  assert.match(events, /export function emitSubscriptionChanged/);
  assert.match(read('hooks/useSubscription.ts'), /onSubscriptionChanged\(refresh\)/);
});

test('a double tap cannot spend a one-shot code twice', () => {
  // The guard has to be synchronous. Two taps in the same React batch both
  // read the stale `busy === false` out of their closure, so `busy` alone is
  // not a lock — a ref flips on the first tap.
  assert.match(screen, /inFlight = useRef\(false\)/);
  assert.match(screen, /if \(inFlight\.current[\s\S]{0,80}?\) return;/);
  assert.match(screen, /inFlight\.current = true;/);
  // ...and the flag must be set before the first await, or two taps can both
  // get past the guard while the first one is still resolving.
  const guardAt = screen.indexOf('inFlight.current = true;');
  const awaitAt = screen.indexOf('await redeemCode(code)');
  assert.ok(guardAt !== -1 && awaitAt > guardAt, 'the guard must close before the request starts');
  assert.match(screen, /disabled=\{busy \|\| !complete\}/);
});

test('the field is set up for a printed code, not for prose', () => {
  assert.match(screen, /autoCapitalize="characters"/);
  assert.match(screen, /autoCorrect=\{false\}/);
  assert.match(screen, /autoComplete="off"/);
  assert.match(screen, /keyboardType="default"/);
  assert.match(screen, /editable=\{!busy\}/);
});

test('the screen claims no free trial', () => {
  // lib/iap.ts:ProOffering.trialDays only claims a trial the store reported,
  // because promising one to an ineligible lapsed subscriber charges them
  // immediately (App Review 3.1.2 + real money). Nothing here may reintroduce
  // the claim.
  assert.doesNotMatch(screen, /free trial|days free/i);
  assert.doesNotMatch(lib, /free trial|days free/i);
});

// ─── The request ───

test('the request body carries the code and nothing else', () => {
  // The granted user comes from the VERIFIED JWT. A user id in the body is a
  // caller-supplied claim about who to make Pro — a free lifetime entitlement
  // for anyone who can edit a request.
  const start = lib.indexOf("functions.invoke('redeem-code'");
  assert.notEqual(start, -1, 'lib/redeemCode.ts must invoke the redeem-code function');
  const call = lib.slice(start, lib.indexOf('});', start));
  assert.match(call, /body: \{ code:/, 'the body must send the code');
  assert.doesNotMatch(
    call,
    /user|uid|sub|email/i,
    'nothing identifying the user may ride in the request body'
  );
});

test('the client still says out loud that its normalisation is not a control', () => {
  // The comment is the artefact that stops a future reader deleting the
  // server-side re-validation as "redundant".
  assert.match(lib, /NEVER A CONTROL/i);
  assert.match(lib, /server normalises/i);
});

// ─── The entitlement gate this feature rides on ───

test('an active status with no expiry still reads as lifetime', () => {
  // The redemption writes exactly profiles.subscription_status = 'active' with
  // subscription_expires_at = NULL, and nothing else opens the gate. If this
  // branch ever moves below the date comparison, `new Date(null) > new Date()`
  // is false and every redeemed golfer silently loses Pro.
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

test('a false RevenueCat entitlement does not shadow a redeemed lifetime grant', () => {
  // A redeemed user has no StoreKit purchase, so isProActive() is false for
  // them. Only a TRUE may short-circuit; a false has to fall through to the
  // Supabase profile read or redemption never unlocks anything.
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

test('the placeholder prices match the real App Store prices', () => {
  assert.match(config, /monthlyPriceAud: 1499,/, 'monthly is A$14.99');
  assert.match(config, /annualPriceAud: 9999,/, 'annual is A$99.99');
});

test('the stub savings badge still computes to a sensible whole percentage', () => {
  // lib/iap.ts derives the annual card's "Save N%" from these two constants.
  // A pair that produces 0%, a negative, or a non-integer would ship a
  // nonsense badge to anyone on an unconfigured build.
  assert.match(
    iap,
    /Math\.round\(\(1 - annual \/ \(monthly \* 12\)\) \* 100\)/,
    'if the badge formula changes, this expectation has to change with it'
  );
  const monthly = Number(config.match(/monthlyPriceAud: (\d+),/)?.[1]);
  const annual = Number(config.match(/annualPriceAud: (\d+),/)?.[1]);
  const savings = Math.round((1 - annual / (monthly * 12)) * 100);
  assert.equal(savings, 44, `expected "Save 44%", got "Save ${savings}%"`);
  assert.ok(Number.isInteger(savings) && savings > 0 && savings < 100);
});

test('the placeholder prices still feed only the stub offering', () => {
  // Real builds render store-localised priceStrings. If config prices ever
  // reach the RevenueCat path, a stale constant becomes a price a customer is
  // shown next to a different price Apple actually charges.
  const stubStart = iap.indexOf('const StubProvider');
  const stubEnd = iap.indexOf('const RevenueCatProvider');
  assert.ok(stubStart !== -1 && stubEnd > stubStart);
  const rcProvider = iap.slice(stubEnd);
  assert.doesNotMatch(
    rcProvider,
    /monthlyPriceAud|annualPriceAud/,
    'the RevenueCat provider must never read the placeholder prices'
  );
  assert.match(iap.slice(stubStart, stubEnd), /config\.subscription\.monthlyPriceAud/);
  assert.match(rcProvider, /priceLabel: pkg\.product\.priceString/);
});
