import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ticket, Check, AlertCircle } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { iap, type CodeRedemptionOutcome } from '@/lib/iap';
import { SUPPORT_EMAIL } from '@/constants/support';

/**
 * Redeem an App Store Offer Code for Clippar Pro.
 *
 * WHY THIS SCREEN NO LONGER HAS A TEXT FIELD.
 *
 * It used to take a printed CLIP-xxxx code, HMAC it with a server-side pepper
 * and grant a lifetime entitlement from our own `redemption_codes` table.
 * Guideline 3.1.1 prohibits unlocking features with a developer's own license
 * keys, and a code box that turns a string into paid functionality is the
 * exact shape of the thing the rule names. Whether a reviewer would have
 * called it is not worth finding out on a first submission — Henry's call,
 * 2026-08-04.
 *
 * Apple's Offer Codes do the same job through StoreKit: Henry generates
 * one-time-use codes in App Store Connect, hands them out, and the customer
 * redeems in the sheet below. Apple validates, RevenueCat observes the
 * transaction, the entitlement listener flips the app to Pro. No code of ours
 * is in the trust path, so there is nothing here to brute-force and no secret
 * to keep.
 *
 * The old server side (supabase/migrations/018_redemption_codes.sql and
 * supabase/functions/redeem-code) is superseded and carries a DO-NOT-APPLY
 * header. It was never applied to any database, so there is nothing to migrate.
 */
export default function RedeemCodeScreen() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CodeRedemptionOutcome | null>(null);

  // Ref, not state: two taps landing in the same React batch both read the
  // stale `busy === false` from their closure, and presenting Apple's sheet
  // twice stacks two modals.
  const inFlight = useRef(false);

  const handleRedeem = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await iap.presentCodeRedemption();
      setOutcome(result);
      Haptics.notificationAsync(
        result.status === 'activated'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning
      );
    } catch {
      // presentCodeRedemption is total — it converts its own failures into an
      // 'unavailable' outcome. This exists so a future throw cannot strand the
      // button mid-flight.
      setOutcome({
        status: 'unavailable',
        reason: 'Something went wrong opening the App Store. Try again in a moment.',
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  const message = outcome ? describeOutcome(outcome) : null;
  const activated = outcome?.status === 'activated';

  return (
    <>
      <Stack.Screen options={{ title: 'Redeem a Code' }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={{ alignItems: 'center', marginTop: 8 }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: theme.colors.primaryMuted,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <Ticket size={26} color={theme.colors.primary} />
          </View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 20, fontWeight: '800' }}>
            Redeem your code
          </Text>
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginTop: 6,
              textAlign: 'center',
              lineHeight: 20,
            }}
          >
            Tap below and enter your code in the App Store sheet. Your Pro access unlocks as
            soon as Apple confirms it.
          </Text>
        </View>

        <Button
          title={busy ? 'Opening App Store…' : 'Enter code'}
          onPress={handleRedeem}
          loading={busy}
          disabled={busy}
        />

        {message ? (
          <Card
            style={{
              borderColor:
                message.tone === 'success' ? theme.colors.primary : theme.colors.surfaceBorder,
              flexDirection: 'row',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            {message.tone === 'success' ? (
              <Check size={20} color={theme.colors.primary} />
            ) : (
              <AlertCircle size={20} color={theme.colors.accentRed} />
            )}
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color:
                    message.tone === 'success' ? theme.colors.primary : theme.colors.textPrimary,
                  fontSize: 15,
                  fontWeight: '700',
                }}
              >
                {message.headline}
              </Text>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  lineHeight: 19,
                  marginTop: 4,
                }}
              >
                {message.detail}
              </Text>
            </View>
          </Card>
        ) : null}

        {activated ? (
          <Button title="Done" variant="secondary" onPress={() => router.back()} />
        ) : null}

        <Text
          style={{
            color: theme.colors.textTertiary,
            fontSize: 12,
            lineHeight: 18,
            textAlign: 'center',
          }}
        >
          {`Codes are issued by Clippar and are not for sale. If yours will not redeem, email ${SUPPORT_EMAIL} and we will sort it out.`}
        </Text>
      </ScrollView>
    </>
  );
}

interface OutcomeMessage {
  tone: 'success' | 'neutral';
  headline: string;
  detail: string;
}

/**
 * 'dismissed' is NOT reported as failure. StoreKit tells us nothing about what
 * the user typed, and Apple's receipt can land after we stop polling — so the
 * only truthful thing to say is "we haven't seen it yet", with the reason it
 * might still turn up. Telling someone their valid code failed, when it is
 * about to work, is worse than telling them to wait.
 */
export function describeOutcome(outcome: CodeRedemptionOutcome): OutcomeMessage {
  switch (outcome.status) {
    case 'activated':
      return {
        tone: 'success',
        headline: 'Clippar Pro is active',
        detail: 'Everything is unlocked. Go make a reel.',
      };
    case 'dismissed':
      return {
        tone: 'neutral',
        headline: 'No code redeemed yet',
        detail:
          'If you did enter one, it can take a moment to come through — Pro will switch on by ' +
          'itself. Pull down to refresh your profile if it has not appeared in a minute.',
      };
    case 'unavailable':
      return {
        tone: 'neutral',
        headline: 'Cannot redeem right now',
        detail: outcome.reason,
      };
  }
}
