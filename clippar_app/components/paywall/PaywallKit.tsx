/**
 * The parts both paywall layers share: the store plumbing, the plan cards,
 * Apple's required fixtures, and the way out.
 *
 * Layer 1 is app/paywall.tsx (the paid offer); layer 2 is
 * app/paywall-trial.tsx (what Pro actually does, then the free trial). They
 * differ in what they SAY — every word of which comes from lib/paywallCopy.ts
 * — not in how they buy, restore or exit. Keeping those three here means a
 * fix to the exit contract, the restore affordance or the disclosure lands on
 * both layers at once; two hand-copied screens would drift, and the one that
 * drifted would be the one Apple opened.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { Check, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { iap, type ProOffering, type ProPlan } from '@/lib/iap';
import { emitSubscriptionChanged } from '@/lib/subscriptionEvents';
import { getDevProOverride, isDevVariant, toggleDevProOverride } from '@/lib/devPro';
import {
  planPriceLine,
  trialBadgeLabel,
  type PaywallLayer,
} from '@/lib/paywallCopy';

const TERMS_URL = 'https://clippargolf.com/terms';
const PRIVACY_URL = 'https://clippargolf.com/privacy';

/**
 * Where "done with this paywall" goes — THE funnel contract, in one place so
 * neither layer can quietly grow a `router.back()`.
 *
 * Opened with ?from=onboarding the paywall sits BEFORE the account exists, so
 * every terminal action (close, purchase, restore, continue to free) has to
 * continue FORWARD to signup. Going back would land the visitor on a finished
 * onboarding funnel with nowhere left to go — a dead end that reads as a
 * frozen app. Opened from inside the app (Profile, editor export gate) it is
 * an ordinary modal and back is exactly right.
 */
export function usePaywallExit(from?: string) {
  const fromOnboarding = from === 'onboarding';
  const exit = useCallback(() => {
    if (fromOnboarding) router.replace('/(auth)/signup');
    else router.back();
  }, [fromOnboarding]);
  return { fromOnboarding, exit };
}

/**
 * Offerings + purchase + restore, identical on both layers.
 * `onDone` runs after a completed purchase or a successful restore — pass the
 * screen's exit() so the contract above holds wherever it is used.
 */
export function usePaywallCommerce({ onDone }: { onDone: () => void }) {
  const [offerings, setOfferings] = useState<ProOffering[]>([]);
  const [selected, setSelected] = useState<ProPlan>('annual');
  const [busy, setBusy] = useState(false);
  // Distinguishes "still asking the store" from "the store has nothing".
  // Without it an empty list renders a spinner forever, which is what the
  // stub path now produces whenever StoreKit is unreachable.
  const [offeringsLoaded, setOfferingsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    iap
      .getOfferings()
      .then((o) => {
        if (!cancelled) setOfferings(o);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setOfferingsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedOffering = offerings.find((o) => o.plan === selected) ?? null;

  const handlePurchase = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    Haptics.selectionAsync();
    try {
      await iap.purchase(selected);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Optimistic refresh: the entitlement is live now, so flip the UI before
      // the webhook syncs the Supabase profile.
      emitSubscriptionChanged();
      Alert.alert('Welcome to Clippar Pro!', 'Everything is unlocked. Go film something great.');
      onDone();
    } catch (err) {
      Alert.alert('Purchase not completed', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, selected, onDone]);

  const handleRestore = useCallback(async () => {
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
      if (restored) onDone();
    } finally {
      setBusy(false);
    }
  }, [busy, onDone]);

  return {
    offerings,
    offeringsLoaded,
    selected,
    setSelected,
    selectedOffering,
    busy,
    handlePurchase,
    handleRestore,
  };
}

/* ── Chrome ───────────────────────────────────────────────────────────── */

/** The dismiss control every paywall needs. Runs the layer's exit(), so it
 *  really does dismiss rather than routing the golfer somewhere else. */
export function PaywallCloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Close"
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
  );
}

/* ── Plans ────────────────────────────────────────────────────────────── */

/**
 * The priced plan cards. `layer` decides whether a trial may be named at all
 * — the card never reads offering.trialDays itself, it asks lib/paywallCopy.
 */
export function PlanCards({
  offerings,
  selected,
  onSelect,
  layer,
}: {
  offerings: ProOffering[];
  selected: ProPlan;
  onSelect: (plan: ProPlan) => void;
  layer: PaywallLayer;
}) {
  return (
    <View style={{ gap: 10 }}>
      {offerings.map((o) => {
        const active = selected === o.plan;
        const trialBadge = trialBadgeLabel(o, layer);
        return (
          <Pressable
            key={o.plan}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(o.plan);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
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
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '800', fontSize: 16 }}>
                  {o.plan === 'annual' ? 'Annual' : o.plan === 'lifetime' ? 'Lifetime' : 'Monthly'}
                </Text>
                {trialBadge ? (
                  <View
                    style={{
                      backgroundColor: `${theme.colors.primary}22`,
                      borderRadius: 6,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                    }}
                  >
                    <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '800' }}>
                      {trialBadge}
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
                    <Text style={{ color: theme.colors.accentGold, fontSize: 11, fontWeight: '800' }}>
                      {o.badge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                {planPriceLine(o, layer)}
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
  );
}

/* ── Apple's required fixtures ────────────────────────────────────────── */

/**
 * Guideline 3.1.2's conspicuous disclosure: price, billing period, what
 * renewal does and where to turn it off. Rendered directly under the CTA on
 * whichever layer is selling, because "adjacent to the purchase" is the part
 * reviewers check. Text comes from lib/paywallCopy so it can never claim a
 * trial the store did not report.
 */
export function PurchaseDisclosure({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Text
      style={{
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 16,
        textAlign: 'center',
        marginTop: 12,
      }}
    >
      {text}
    </Text>
  );
}

/**
 * Restore Purchases + Terms + Privacy. Required on EVERY paywall, so it
 * ships as one component rather than as three links a second layer might
 * forget: a paywall without Restore is a rejection, and a subscriber who
 * reinstalled has no other way back to what they already paid for.
 */
export function PaywallFixtures({ onRestore, busy }: { onRestore: () => void; busy?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 18, marginTop: 14 }}>
      <Pressable onPress={onRestore} disabled={busy} hitSlop={8} accessibilityRole="button">
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Restore Purchases</Text>
      </Pressable>
      <Pressable onPress={() => Linking.openURL(TERMS_URL)} hitSlop={8} accessibilityRole="link">
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Terms</Text>
      </Pressable>
      <Pressable onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={8} accessibilityRole="link">
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Privacy</Text>
      </Pressable>
    </View>
  );
}

/* ── The way out ──────────────────────────────────────────────────────── */

/**
 * The plain-text way to the free tier, at the foot of both layers.
 *
 * Subordinate to the purchase CTA is the point; camouflaged is a rejection.
 * Guideline 3.1.2 rejections are written about dismiss paths that are hard to
 * find or invisible against the background, so this component fixes the
 * things that get apps pulled and leaves only the words to the caller:
 *
 *  - textSecondary (#9E9EB8 on #0A0A0F ≈ 7.5:1) — a real text colour from the
 *    theme, never textTertiary and never a tint of the background.
 *  - full opacity. No 0.3 "ghost" link.
 *  - a 44×44pt minimum target plus hitSlop, per Apple's HIG.
 *  - rendered OUTSIDE the scroll view by both layers, so it is on screen at
 *    the first frame on the smallest phone we support rather than below the
 *    fold.
 */
export function ContinueFreeLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={12}
      style={{
        alignSelf: 'center',
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 15,
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ── Dev-only escape hatch ────────────────────────────────────────────── */

/**
 * "Clippar Dev" (com.clippar.app.dev) has no App Store products, so a real
 * purchase can NEVER succeed there — without this, every Pro path is untestable
 * in development. isDevVariant() is fail-closed: outside the dev variant the
 * control never renders and lib/devPro never even reads the persisted flag.
 */
export function DevProToggle({ onUnlocked }: { onUnlocked: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const dev = isDevVariant();

  useEffect(() => {
    if (dev) getDevProOverride().then(setUnlocked).catch(() => {});
  }, [dev]);

  if (!dev) return null;

  const toggle = async () => {
    const next = await toggleDevProOverride();
    setUnlocked(next);
    emitSubscriptionChanged();
    if (next) {
      Alert.alert('Dev Pro unlocked', 'Pro features are unlocked on this device. Tap again to relock.');
      onUnlocked();
    } else {
      Alert.alert('Dev Pro relocked', 'The local override is off — gating behaves like a free user again.');
    }
  };

  return (
    <Pressable onPress={toggle} hitSlop={8} style={{ alignSelf: 'center', marginTop: 14 }}>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 12,
          textDecorationLine: 'underline',
        }}
      >
        {unlocked ? 'Dev: Pro unlocked — tap to relock' : 'Dev: unlock Pro'}
      </Text>
    </Pressable>
  );
}
