import { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, Linking, ActivityIndicator, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Crown, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { iap, type ProOffering, type ProPlan } from '@/lib/iap';
import { emitSubscriptionChanged } from '@/lib/subscriptionEvents';
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
const PRO_FEATURES = [
  'Unlimited highlight reels',
  'Unlimited exports & shares',
  'Shot tracer on every full swing',
  'All detection & trim settings',
];

const TRIAL_DAYS = 14;

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromOnboarding = from === 'onboarding';
  const [offerings, setOfferings] = useState<ProOffering[]>([]);
  const [selected, setSelected] = useState<ProPlan>('annual');
  const [busy, setBusy] = useState(false);
  const [personalLine, setPersonalLine] = useState<string | null>(null);

  useEffect(() => {
    iap.getOfferings().then(setOfferings).catch(() => {});
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
                      {o.plan !== 'lifetime' ? (
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
                            {TRIAL_DAYS} days free
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
                      {o.plan === 'lifetime'
                        ? `${o.priceLabel} ${o.periodLabel}`
                        : `${TRIAL_DAYS} days free, then ${o.priceLabel} ${o.periodLabel}`}
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
                ? `Start my ${TRIAL_DAYS} days free`
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
              : `Free for ${TRIAL_DAYS} days, then ${selectedOffering.priceLabel} ${selectedOffering.periodLabel}. Payment is charged to your Apple ID at confirmation of purchase. The subscription automatically renews unless auto-renew is turned off at least 24 hours before the end of the current period. Manage or cancel anytime in your Apple Account Settings.`}
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
      </ScrollView>
    </View>
  );
}
