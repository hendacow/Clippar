import { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, Linking, ActivityIndicator, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Crown, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { Button } from '@/components/ui/Button';
import { iap, type ProOffering, type ProPlan } from '@/lib/iap';
import { emitSubscriptionChanged } from '@/lib/subscriptionEvents';
import { getDevProOverride, isDevVariant, toggleDevProOverride } from '@/lib/devPro';
import { getOnboardingProfile, intentEcho } from '@/lib/onboardingProfile';

/**
 * Clippar Pro paywall (App Review 3.1.1-compliant: StoreKit IAP only — no
 * external purchase links; Terms + Privacy + Restore are required fixtures).
 * Purchases flow through lib/iap.ts; this screen renders whatever offerings
 * that layer reports, so wiring RevenueCat changes nothing here.
 *
 * 14-DAY FREE TRIAL framing (founder decision — 14, not 7):
 * TODO(asc-intro-offer): the trial itself is granted by App Store Connect —
 * create a Free Introductory Offer, duration 2 weeks, on the subscription
 * products; RevenueCat then surfaces + enforces eligibility automatically.
 * Prices are NEVER hardcoded here: they render from the offering's
 * priceString (lib/iap falls back to config placeholder pricing when the
 * store layer is unavailable, unchanged).
 *
 * When opened with ?from=onboarding (pre-signup funnel handoff), every exit
 * — close, purchase, restore — continues forward to signup instead of
 * router.back(), so the funnel never dead-ends.
 */
/**
 * What Pro unlocks IN THIS BINARY — never what's on the roadmap.
 *
 * App Review 3.1.2 (and plain consumer law) treats a purchase screen listing
 * a feature the build does not deliver as misrepresentation, so every line
 * here must be true of the shipping app at the moment it renders:
 *
 *  • Unlimited reels / exports — real: config.subscription.enforceExportGate
 *    is ON, so "Create Highlight Reel" routes free users to this paywall
 *    (app/round/editor.tsx).
 *  • Cloud backup — real: gated on isSubscribed in
 *    app/profile/storage-settings.tsx.
 *  • Shot tracer — DERIVED from config.tracer.enabled, never hardcoded. The
 *    flag is OFF for v1 prod (it hasn't passed a real-round field test), so
 *    the line is absent from the shipping build and comes back on its own the
 *    day the flag flips. Do NOT re-add it as a string literal, and do not
 *    sell it as "coming soon" — Apple does not allow charging for
 *    unreleased functionality either.
 *
 * Dropped deliberately: "All detection & trim settings". Trim Settings is an
 * ungated row in Profile (app/(tabs)/profile.tsx) — free users already have
 * it, so billing it as a Pro benefit was the same misrepresentation.
 */
const PRO_FEATURES = [
  'Unlimited highlight reels',
  'Unlimited exports & shares',
  ...(config.tracer.enabled ? ['Shot tracer on every full swing'] : []),
  'Cloud backup for every clip',
];

// Trial length comes from the STORE (ProOffering.trialDays, derived from the
// package's free intro offer + user eligibility) — never hardcoded. Until the
// 14-day Free Introductory Offer exists in App Store Connect, offerings carry
// no trialDays and this paywall shows plain pricing with no trial claims.

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromOnboarding = from === 'onboarding';
  const [offerings, setOfferings] = useState<ProOffering[]>([]);
  const [selected, setSelected] = useState<ProPlan>('annual');
  const [busy, setBusy] = useState(false);
  const [personalLine, setPersonalLine] = useState<string | null>(null);
  // Dev-only paywall bypass state ("Clippar Dev" builds have no App Store
  // products, so real purchases can never succeed there). isDevVariant() is
  // fail-closed: outside the dev variant the action never renders and the
  // persisted flag is never even read (lib/devPro.ts).
  const [devUnlocked, setDevUnlocked] = useState(false);

  useEffect(() => {
    iap.getOfferings().then(setOfferings).catch(() => {});
    if (isDevVariant()) {
      getDevProOverride().then(setDevUnlocked).catch(() => {});
    }
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

  const selectedOffering = offerings.find((o) => o.plan === selected) ?? null;
  const selectedIsSubscription = selectedOffering ? selectedOffering.plan !== 'lifetime' : true;

  /** Where "done with the paywall" goes: forward to signup when the
   *  pre-signup onboarding funnel opened us, otherwise back. */
  const exit = () => {
    if (fromOnboarding) router.replace('/(auth)/signup');
    else router.back();
  };

  const handlePurchase = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.selectionAsync();
    try {
      await iap.purchase(selected);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Optimistic refresh: entitlement is live now, so flip the UI before the
      // webhook syncs the Supabase profile.
      emitSubscriptionChanged();
      Alert.alert('Welcome to Clippar Pro!', 'Everything is unlocked. Go film something great.');
      exit();
    } catch (err) {
      Alert.alert('Purchase not completed', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Dev builds only: toggle the persisted local Pro override (tap again to
   *  relock). Production binaries never render the control and lib/devPro
   *  no-ops there anyway — double fail-closed. */
  const handleDevToggle = async () => {
    if (busy || !isDevVariant()) return;
    const next = await toggleDevProOverride();
    setDevUnlocked(next);
    emitSubscriptionChanged();
    if (next) {
      Alert.alert('Dev Pro unlocked', 'Pro features are unlocked on this device. Tap again to relock.');
      exit();
    } else {
      Alert.alert('Dev Pro relocked', 'The local override is off — gating behaves like a free user again.');
    }
  };

  const handleRestore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const restored = await iap.restore();
      if (restored) emitSubscriptionChanged();
      Alert.alert(
        restored ? 'Purchases restored' : 'Nothing to restore',
        restored
          ? 'Your Pro subscription is active again.'
          : 'No previous Clippar Pro purchase was found for this Apple ID.'
      );
      if (restored) exit();
    } finally {
      setBusy(false);
    }
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
      {/* Close */}
      <Pressable
        onPress={exit}
        hitSlop={12}
        style={{
          alignSelf: 'flex-start',
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: theme.colors.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={20} color={theme.colors.textSecondary} />
      </Pressable>

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
          <ActivityIndicator color={theme.colors.primary} style={{ marginVertical: 24 }} />
        ) : (
          <View style={{ gap: 10, marginBottom: 16 }}>
            {offerings.map((o) => {
              const active = selected === o.plan;
              return (
                <Pressable
                  key={o.plan}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelected(o.plan);
                  }}
                  style={{
                    borderRadius: theme.radius.lg,
                    borderWidth: 2,
                    borderColor: active ? theme.colors.primary : theme.colors.surfaceBorder,
                    backgroundColor: theme.colors.surfaceElevated,
                    padding: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Text
                        style={{ color: theme.colors.textPrimary, fontWeight: '800', fontSize: 16 }}
                      >
                        {o.plan === 'annual' ? 'Annual' : o.plan === 'lifetime' ? 'Lifetime' : 'Monthly'}
                      </Text>
                      {o.trialDays ? (
                        <View
                          style={{
                            backgroundColor: `${theme.colors.primary}22`,
                            borderRadius: 6,
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                          }}
                        >
                          <Text
                            style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '800' }}
                          >
                            {o.trialDays} days free
                          </Text>
                        </View>
                      ) : null}
                      {o.badge ? (
                        <View
                          style={{
                            backgroundColor: `${theme.colors.accentGold}22`,
                            borderRadius: 6,
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                          }}
                        >
                          <Text
                            style={{ color: theme.colors.accentGold, fontSize: 11, fontWeight: '800' }}
                          >
                            {o.badge}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                      {o.plan === 'lifetime' || !o.trialDays
                        ? `${o.priceLabel} ${o.periodLabel}`
                        : `${o.trialDays} days free, then ${o.priceLabel} ${o.periodLabel}`}
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      borderWidth: 2,
                      borderColor: active ? theme.colors.primary : theme.colors.surfaceBorder,
                      backgroundColor: active ? theme.colors.primary : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {active ? <Check size={14} color="#fff" /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={{ flex: 1 }} />

        <Button
          title={
            busy
              ? 'One sec…'
              : selectedIsSubscription
                ? selectedOffering?.trialDays
                  ? `Start my ${selectedOffering.trialDays} days free`
                  : 'Subscribe'
                : 'Continue'
          }
          onPress={handlePurchase}
          disabled={busy || offerings.length === 0}
        />

        {/* Apple 3.1.2 auto-renew disclosure — conspicuous, adjacent to the
            CTA, price always from the store-reported priceString. */}
        {selectedOffering ? (
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 11,
              lineHeight: 16,
              textAlign: 'center',
              marginTop: 12,
            }}
          >
            {selectedOffering.plan === 'lifetime'
              ? `One-time purchase of ${selectedOffering.priceLabel}. Payment is charged to your Apple ID at confirmation of purchase. No subscription, nothing renews.`
              : `${
                  selectedOffering.trialDays
                    ? `Free for ${selectedOffering.trialDays} days, then ${selectedOffering.priceLabel} ${selectedOffering.periodLabel}.`
                    : `${selectedOffering.priceLabel} ${selectedOffering.periodLabel}.`
                } Payment is charged to your Apple ID at confirmation of purchase. The subscription automatically renews unless auto-renew is turned off at least 24 hours before the end of the current period. Manage or cancel anytime in your Apple Account Settings.`}
          </Text>
        ) : null}

        {/* Required paywall fixtures */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 18,
            marginTop: 14,
          }}
        >
          <Pressable onPress={handleRestore} hitSlop={8}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Restore Purchases</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL('https://clippargolf.com/terms')} hitSlop={8}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Terms</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL('https://clippargolf.com/privacy')} hitSlop={8}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Privacy</Text>
          </Pressable>
        </View>

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

        {/* Dev-only escape hatch: com.clippar.app.dev has no App Store
            products, so a real purchase can never succeed in dev builds.
            Never rendered outside the dev variant (fail-closed). */}
        {isDevVariant() ? (
          <Pressable onPress={handleDevToggle} hitSlop={8} style={{ alignSelf: 'center', marginTop: 14 }}>
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 12,
                textDecorationLine: 'underline',
              }}
            >
              {devUnlocked ? 'Dev: Pro unlocked — tap to relock' : 'Dev: unlock Pro'}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
