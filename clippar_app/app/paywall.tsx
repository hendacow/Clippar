import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Crown, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { Button } from '@/components/ui/Button';
import {
  ContinueFreeLink,
  DevProToggle,
  PaywallCloseButton,
  PaywallFixtures,
  PlanCards,
  PurchaseDisclosure,
  usePaywallCommerce,
  usePaywallExit,
} from '@/components/paywall/PaywallKit';
import {
  freeExitLabel,
  purchaseCtaLabel,
  renewalDisclosure,
  type PaywallLayer,
} from '@/lib/paywallCopy';
import { getOnboardingProfile, intentEcho } from '@/lib/onboardingProfile';

/**
 * Clippar Pro paywall, LAYER 1 — the paid offer (App Review 3.1.1-compliant:
 * StoreKit IAP only — no external purchase links; Terms + Privacy + Restore
 * are required fixtures). Purchases flow through lib/iap.ts; this screen
 * renders whatever offerings that layer reports, so wiring RevenueCat changes
 * nothing here. Prices are NEVER hardcoded: they render from the offering's
 * priceString (lib/iap falls back to config placeholder pricing when the
 * store layer is unavailable, unchanged).
 *
 * TWO LAYERS, and this is the first:
 *  1. HERE — monthly and annual at full price. It does not mention a free
 *     trial, even when the store reports one. Held back on purpose: someone
 *     who never takes the exit buys outright, and the trial stays in reserve.
 *  2. app/paywall-trial.tsx — reached ONLY by tapping "Continue to free"
 *     below. It spells out what Pro actually does and then offers the trial
 *     the store confirmed, with a genuine way on to the free tier under it.
 * Everything either layer says about price and trials comes from
 * lib/paywallCopy.ts, which cannot claim a trial the store did not report —
 * see the rule in that file's header. Silence about a trial is a marketing
 * decision; a false trial is a lapsed subscriber charged A$99.99 on a tap.
 *
 * EXITS. When opened with ?from=onboarding (pre-signup funnel handoff) every
 * terminal action — close, purchase, restore — continues forward to signup
 * instead of router.back(), so the funnel never dead-ends. That rule now
 * lives in PaywallKit.usePaywallExit and is shared with layer 2. There are
 * two ways off this screen and both are always visible without scrolling:
 * the close button top-left (out, immediately) and "Continue to free" pinned
 * at the foot (out, via the second-chance layer).
 */
/**
 * What Pro unlocks IN THIS BINARY — never what's on the roadmap.
 *
 * App Review 3.1.2 (and plain consumer law) treats a purchase screen listing
 * a feature the build does not deliver as misrepresentation, so every line
 * here must be true of the shipping app at the moment it renders:
 *
 *  • Cloud backup — real, and with the export gate OFF (2026-08-05, see
 *    config.subscription.enforceExportGate) it is the ONLY thing Pro gates:
 *    isSubscribed in app/profile/storage-settings.tsx + lib/uploadQueue.ts.
 *    The three bullets are three true facets of that one feature — safety,
 *    automatic upload, reinstall survival — not three features.
 *  • Shot tracer — DERIVED from config.tracer.enabled, never hardcoded. The
 *    flag is OFF for v1 prod (it hasn't passed a real-round field test), so
 *    the line is absent from the shipping build and comes back on its own the
 *    day the flag flips. Do NOT re-add it as a string literal, and do not
 *    sell it as "coming soon" — Apple does not allow charging for
 *    unreleased functionality either.
 *
 * Dropped deliberately:
 *  - "Unlimited highlight reels" / "Unlimited exports & shares" — removed
 *    2026-08-05 with the export gate. Everyone gets those free now; selling
 *    them as Pro is the same misrepresentation in the other direction. If
 *    the gate goes back ON, restore them — flag and copy move together.
 *  - "All detection & trim settings". Trim Settings is an ungated row in
 *    Profile (app/(tabs)/profile.tsx) — free users already have it.
 */
const PRO_FEATURES = [
  'Cloud backup for every clip',
  'Automatic upload in the background',
  ...(config.tracer.enabled ? ['Shot tracer on every full swing'] : []),
  'Rounds that survive a lost or new phone',
];

// This screen is the full-price offer. The constant is what stops a future
// edit reintroducing trial copy here by hand: every string below is resolved
// for LAYER, and for 'offer' lib/paywallCopy answers "no trial" no matter
// what the store reported.
const LAYER: PaywallLayer = 'offer';

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { fromOnboarding, exit } = usePaywallExit(from);
  const {
    offerings,
    offeringsLoaded,
    selected,
    setSelected,
    selectedOffering,
    busy,
    handlePurchase,
    handleRestore,
  } =
    usePaywallCommerce({ onDone: exit });
  const [personalLine, setPersonalLine] = useState<string | null>(null);

  useEffect(() => {
    // Echo the user's onboarding answers back (self-reference cue). Absent
    // answers → no line, nothing invented.
    getOnboardingProfile()
      .then((p) => {
        const course = p.homeCourseName;
        const intent = p.intent ? intentEcho[p.intent] : null;
        if (course && intent) setPersonalLine(`Reels from ${course}, tuned for ${intent}.`);
        else if (course) setPersonalLine(`Reels from ${course}, ready to share.`);
        else if (intent) setPersonalLine(`Everything pointed at ${intent}.`);
      })
      .catch(() => {});
  }, []);

  /** The exit that does not give up on the sale: layer 2 makes the case
   *  concretely and offers whatever trial the store confirmed, and its own
   *  exit really does land on the free tier. REPLACE, not push — the funnel
   *  arrived here with router.replace too, so the stack stays one screen deep
   *  and a later replace to signup leaves no orphaned paywall behind it. */
  const continueToFree = () => {
    Haptics.selectionAsync();
    router.replace(
      fromOnboarding
        ? { pathname: '/paywall-trial', params: { from: 'onboarding' } }
        : '/paywall-trial'
    );
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 20,
      }}
    >
      <PaywallCloseButton onPress={exit} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
        {/* Hero */}
        <View style={{ alignItems: 'center', marginTop: 12, marginBottom: 20 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: `${theme.colors.primary}22`,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <Crown size={30} color={theme.colors.primary} />
          </View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 26, fontWeight: '900' }}>
            Clippar Pro
          </Text>
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginTop: 6,
              textAlign: 'center',
            }}
          >
            Every round, fully cut. No limits.
          </Text>
          {personalLine ? (
            <Text
              style={{
                color: theme.colors.primaryLight,
                fontSize: 13,
                fontWeight: '600',
                marginTop: 8,
                textAlign: 'center',
              }}
            >
              {personalLine}
            </Text>
          ) : null}
        </View>

        {/* Features */}
        <View style={{ gap: 12, marginBottom: 24 }}>
          {PRO_FEATURES.map((f) => (
            <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Check size={18} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 15 }}>{f}</Text>
            </View>
          ))}
        </View>

        {/* Plans */}
        {offerings.length === 0 ? (
          /* Three states, not two. A spinner forever is what an empty list
             used to render, and the stub now returns empty whenever StoreKit
             is unreachable — so say so rather than spin. Never a price here:
             we do not know the user's storefront in this branch. */
          offeringsLoaded ? (
            <Text
              style={{
                color: theme.colors.textSecondary,
                textAlign: 'center',
                marginVertical: 24,
                paddingHorizontal: 24,
              }}
            >
              Clippar Pro isn&apos;t available right now. Check your connection and try
              again — nothing has been charged.
            </Text>
          ) : (
            <ActivityIndicator color={theme.colors.primary} style={{ marginVertical: 24 }} />
          )
        ) : (
          <View style={{ marginBottom: 16 }}>
            <PlanCards
              offerings={offerings}
              selected={selected}
              onSelect={setSelected}
              layer={LAYER}
            />
          </View>
        )}

        <View style={{ flex: 1 }} />

        <Button
          title={busy ? 'One sec…' : purchaseCtaLabel(selectedOffering, LAYER)}
          onPress={handlePurchase}
          disabled={busy || offerings.length === 0}
        />

        {/* Apple 3.1.2 auto-renew disclosure — conspicuous, adjacent to the
            CTA, price always from the store-reported priceString. */}
        <PurchaseDisclosure text={renewalDisclosure(selectedOffering, LAYER)} />

        <PaywallFixtures onRestore={handleRestore} busy={busy} />

        {/* Lifetime redemption codes (ambassadors / early supporters).
            Deliberately the same visual weight as Restore, below the fold of
            the CTA: App Review 3.1.1 expects StoreKit to be the prominent way
            to buy, and a second big button here reads as a competing purchase
            path.
            Hidden in the pre-signup funnel (?from=onboarding): a code attaches
            to an account and there isn't one yet, so the link could only lead
            to "Sign in first". The Profile tab row picks that user up the
            moment they have an account. */}
        {!fromOnboarding ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/profile/redeem');
            }}
            hitSlop={8}
            style={{ alignSelf: 'center', marginTop: 14 }}
          >
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
              Have a code?{' '}
              <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Redeem it</Text>
            </Text>
          </Pressable>
        ) : null}

        <DevProToggle onUnlocked={exit} />
      </ScrollView>

      {/* The way out, OUTSIDE the scroll view so it is on screen from the
          first frame rather than below the fold — the thing 3.1.2 rejections
          are actually written about. Small, muted, plain text: subordinate to
          the CTA above it, still legible against the background. */}
      <View style={{ paddingTop: 6 }}>
        <ContinueFreeLink label={freeExitLabel(LAYER)} onPress={continueToFree} />
      </View>
    </View>
  );
}
