import { View, Text, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Cloud, Film, Infinity as InfinityIcon } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
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
  trialHeadline,
  trialReassurance,
  type PaywallLayer,
} from '@/lib/paywallCopy';

/**
 * Clippar Pro paywall, LAYER 2 — the second chance.
 *
 * Reached only from layer 1's "Continue to free" (app/paywall.tsx), by
 * REPLACE rather than push: the funnel arrives at layer 1 with replace too,
 * so the stack stays one screen deep and the eventual replace to signup
 * leaves no orphaned paywall for a back-swipe to find. Layer 1 is therefore
 * not reachable again from here — deliberately, because this layer is a
 * superset of it: the same plans, the same purchase, plus the trial. Sending
 * anyone "back to the plans" would only take options away.
 *
 * What is different from layer 1:
 *  - it stops listing features and says concretely what Pro does, in terms of
 *    the gate the golfer just hit;
 *  - it offers the free trial, which layer 1 deliberately never mentions;
 *  - its exit is the real one. "Continue with the free plan" leaves the paid
 *    funnel: forward to signup from onboarding, back to the app otherwise
 *    (PaywallKit.usePaywallExit). If both layers only led onward to paying,
 *    the app would trap people — a certain 3.1.2 rejection and, worse, a
 *    golfer who cannot use what they downloaded.
 *
 * THE TRIAL CLAIM IS NOT OURS TO MAKE. Every "N days free" on this screen
 * comes from lib/paywallCopy, which reads the store-reported trialDays and
 * nothing else. A lapsed subscriber is ineligible: promising them 14 free
 * days and charging A$99.99 on the tap is real money out of their account.
 * When the store reports no trial, this screen simply sells at full price —
 * every other reason to be here still holds.
 */

// What Pro is, in terms of what the app actually gates today — which, with
// config.subscription.enforceExportGate OFF (2026-08-05, Henry's call: the
// whole reel pipeline is free for v1), is exactly ONE thing: cloud backup
// (app/profile/storage-settings.tsx + lib/uploadQueue.ts, the only remaining
// getProStatus gates in the app). So this screen is a backup pitch, told as
// three facets of that one true feature rather than four claims of which
// three were free anyway:
//  - "The reel stays free" was previously "Pro is the part that turns a round
//    into a finished reel" — false the moment the export gate went off.
//  - "Unlimited reels/exports" sold what everyone gets free — gone.
//  - "Every setting unlocked" claimed the settings screens are Pro. They
//    never were (Trim Settings has no gate) — gone, and do not bring it back.
// The shot tracer is on layer 1's marketing list (flag-derived) but
// deliberately NOT here: config.tracer.enabled is false in the v1 build, and
// this is the screen that gets specific. If the export gate ever goes back
// ON, restore the reel claims here and on layer 1 — flag and copy move
// together (see the comment on enforceExportGate).
const PRO_DETAIL = [
  {
    Icon: Film,
    title: 'The reel stays free',
    body: 'Recording, shot detection, trimming, reels and exports — all of it, free. Pro is for keeping the footage safe.',
  },
  {
    Icon: Cloud,
    title: 'Clips that outlive the phone',
    body: 'Cloud backup keeps your raw clips safe through a reinstall, a lost handset or a full camera roll.',
  },
  {
    Icon: InfinityIcon,
    title: 'Backed up as you go',
    body: 'With backup on, every clip uploads automatically in the background — nothing to remember after the round.',
  },
];

const LAYER: PaywallLayer = 'trial';

export default function PaywallTrialScreen() {
  const insets = useSafeAreaInsets();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { fromOnboarding, exit } = usePaywallExit(from);
  const { offerings, selected, setSelected, selectedOffering, busy, handlePurchase, handleRestore } =
    usePaywallCommerce({ onDone: exit });

  // Null whenever the store did not confirm a trial for this Apple ID — in
  // which case the whole trial block is simply absent and the screen sells at
  // full price. Never a fallback string.
  const headline = trialHeadline(selectedOffering, LAYER);
  const reassurance = trialReassurance(selectedOffering, LAYER);

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
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 24,
            fontWeight: '900',
            marginTop: 14,
            textAlign: 'center',
          }}
        >
          Before you go — what Pro actually does
        </Text>
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 8,
            marginBottom: 22,
            textAlign: 'center',
          }}
        >
          Free Clippar records the round. This is the rest of it.
        </Text>

        {/* The concrete case */}
        <View style={{ gap: 16, marginBottom: 22 }}>
          {PRO_DETAIL.map(({ Icon, title, body }) => (
            <View key={title} style={{ flexDirection: 'row', gap: 12 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: `${theme.colors.primary}22`,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={18} color={theme.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '800' }}>
                  {title}
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 13,
                    lineHeight: 19,
                    marginTop: 3,
                  }}
                >
                  {body}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* The offer. Present only when the store confirmed a free intro
            offer for this Apple ID — otherwise the plans below stand on
            their own at full price. */}
        {headline ? (
          <View
            style={{
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.primary,
              backgroundColor: `${theme.colors.primary}14`,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: '900' }}>
              {headline}
            </Text>
            {reassurance ? (
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  lineHeight: 19,
                  marginTop: 6,
                }}
              >
                {reassurance}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Plans */}
        {offerings.length === 0 ? (
          <ActivityIndicator color={theme.colors.primary} style={{ marginVertical: 24 }} />
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

        {/* Apple 3.1.2: this layer sells, so it carries the same conspicuous
            disclosure as layer 1 — price, period, when the charge lands and
            how to stop it — adjacent to the CTA. */}
        <PurchaseDisclosure text={renewalDisclosure(selectedOffering, LAYER)} />

        <PaywallFixtures onRestore={handleRestore} busy={busy} />

        {/* Same rule as layer 1: a code attaches to an account, and in the
            pre-signup funnel there isn't one yet. Kept here because this
            screen REPLACES layer 1 — without it, an in-app golfer who took
            the exit would lose the code path entirely. */}
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

      {/* The genuine way to the free tier, outside the scroll view so it is
          visible from the first frame. Slightly heavier than layer 1's link
          because this is the terminal exit: nothing sells after it. */}
      <View style={{ paddingTop: 6 }}>
        <ContinueFreeLink label={freeExitLabel(LAYER)} onPress={exit} />
      </View>
    </View>
  );
}
