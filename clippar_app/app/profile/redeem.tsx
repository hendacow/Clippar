import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ticket, Check, AlertCircle } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { emitSubscriptionChanged } from '@/lib/subscriptionEvents';
import {
  CODE_BODY_LENGTH,
  CODE_PREFIX,
  describeRedeemResult,
  formatCodeForDisplay,
  isCompleteCode,
  normalizeCodeInput,
  redeemCode,
  type RedeemResult,
} from '@/lib/redeemCode';

/**
 * Redeem a printed lifetime code (ambassadors / early supporters).
 *
 * Reached from the Profile tab and from a deliberately quiet link on the
 * paywall — App Review 3.1.1 wants StoreKit to be the prominent way to buy, so
 * this path must never look like an alternative purchase route.
 *
 * The result is rendered INLINE rather than in an Alert: the whole job of this
 * screen is the verdict, and an ambassador who hit the rate limit needs to be
 * able to sit and read exactly how long to wait, not dismiss a modal.
 */
export default function RedeemCodeScreen() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RedeemResult | null>(null);

  // The double-submit guard is a REF, not the `busy` state. A code works
  // exactly once, and two taps landing in the same React batch both read the
  // stale `busy === false` from their closure — a ref flips synchronously on
  // the first tap, so the second one has nothing to send.
  const inFlight = useRef(false);

  const bodyLength = normalizeCodeInput(code).length;
  const complete = isCompleteCode(code);

  const handleChange = useCallback((next: string) => {
    // Typing invalidates the previous verdict — leaving "that code did not
    // work" on screen while someone edits the code reads as a live answer.
    setResult(null);
    setCode(formatCodeForDisplay(next));
  }, []);

  const handleRedeem = useCallback(async () => {
    if (inFlight.current || !isCompleteCode(code)) return;
    inFlight.current = true;
    setBusy(true);
    setResult(null);
    Keyboard.dismiss();
    try {
      const outcome = await redeemCode(code);
      setResult(outcome);
      if (outcome.status === 'redeemed') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Exactly what app/paywall.tsx does after a purchase: every mounted
        // useSubscription() re-runs getProStatus(), so the gates open now
        // instead of at the next natural refetch. The grant itself is already
        // durable server-side — this is only the optimistic client refresh.
        emitSubscriptionChanged();
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch {
      // redeemCode() is total, so this is unreachable today. It exists so a
      // future throw cannot strand the button mid-flight.
      setResult({ status: 'server' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [code]);

  const message = result ? describeRedeemResult(result) : null;
  const redeemed = result?.status === 'redeemed';

  return (
    <>
      <Stack.Screen options={{ title: 'Redeem a Code' }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 16 }}
          keyboardShouldPersistTaps="handled"
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
            <Text
              style={{ color: theme.colors.textPrimary, fontSize: 20, fontWeight: '800' }}
            >
              Clippar Pro, for life
            </Text>
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 14,
                marginTop: 6,
                textAlign: 'center',
              }}
            >
              Enter the code from your card. One code, one account, no expiry.
            </Text>
          </View>

          {/* Code field */}
          <View>
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 13,
                fontWeight: '600',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 8,
              }}
            >
              Your code
            </Text>
            <TextInput
              value={code}
              onChangeText={handleChange}
              onSubmitEditing={handleRedeem}
              editable={!busy}
              placeholder={`${CODE_PREFIX}-XXXX-XXXX-XXXX-XXXX`}
              placeholderTextColor={theme.colors.textTertiary}
              // A printed code is upper-case Crockford base32 with no words in
              // it: every one of these stops iOS "helping" by autocapitalising
              // a sentence, autocorrecting a group into a dictionary word, or
              // offering a saved password.
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              spellCheck={false}
              keyboardType="default"
              returnKeyType="done"
              maxLength={CODE_PREFIX.length + 1 + CODE_BODY_LENGTH + 3}
              style={{
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: complete ? theme.colors.primary : theme.colors.surfaceBorder,
                paddingHorizontal: 14,
                paddingVertical: 14,
                color: theme.colors.textPrimary,
                fontSize: 18,
                letterSpacing: 1.5,
                opacity: busy ? 0.6 : 1,
              }}
            />
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 6 }}>
              {`${bodyLength}/${CODE_BODY_LENGTH} characters. We add the ${CODE_PREFIX}- and the dashes for you.`}
            </Text>
          </View>

          {/* Disabled while in flight AND until the code is the right length,
              so a double tap cannot spend a one-shot code twice. */}
          <Button
            title={busy ? 'Redeeming…' : 'Redeem'}
            onPress={handleRedeem}
            loading={busy}
            disabled={busy || !complete}
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
                      message.tone === 'success'
                        ? theme.colors.primary
                        : theme.colors.textPrimary,
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

          {redeemed ? (
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
            Codes are issued by Clippar and are not for sale. If yours will not redeem, email
            support@clippar.com and we will sort it out.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
