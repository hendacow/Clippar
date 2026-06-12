import { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, Linking, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Crown, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { iap, type ProOffering, type ProPlan } from '@/lib/iap';

/**
 * Clippar Pro paywall (App Review 3.1.1-compliant: StoreKit IAP only — no
 * external purchase links; Terms + Privacy + Restore are required fixtures).
 * Purchases flow through lib/iap.ts; this screen renders whatever offerings
 * that layer reports, so wiring RevenueCat changes nothing here.
 */
const PRO_FEATURES = [
  'Unlimited highlight reels',
  'Unlimited exports & shares',
  'Shot tracer on every full swing',
  'All detection & trim settings',
];

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const [offerings, setOfferings] = useState<ProOffering[]>([]);
  const [selected, setSelected] = useState<ProPlan>('annual');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    iap.getOfferings().then(setOfferings).catch(() => {});
  }, []);

  const handlePurchase = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.selectionAsync();
    try {
      await iap.purchase(selected);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Welcome to Clippar Pro!', 'Everything is unlocked. Go film something great.');
      router.back();
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
      Alert.alert(
        restored ? 'Purchases restored' : 'Nothing to restore',
        restored
          ? 'Your Pro subscription is active again.'
          : 'No previous Clippar Pro purchase was found for this Apple ID.'
      );
      if (restored) router.back();
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
        onPress={() => router.back()}
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

      {/* Hero */}
      <View style={{ alignItems: 'center', marginTop: 18, marginBottom: 24 }}>
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: `${theme.colors.primary}22`,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <Crown size={34} color={theme.colors.primary} />
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
      </View>

      {/* Features */}
      <View style={{ gap: 12, marginBottom: 28 }}>
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
        <View style={{ gap: 10, marginBottom: 20 }}>
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
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text
                      style={{ color: theme.colors.textPrimary, fontWeight: '800', fontSize: 16 }}
                    >
                      {o.plan === 'annual' ? 'Annual' : 'Monthly'}
                    </Text>
                    {o.badge ? (
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
                          {o.badge}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                    {o.priceLabel} {o.periodLabel}
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
        title={busy ? 'One sec…' : 'Continue'}
        onPress={handlePurchase}
        disabled={busy || offerings.length === 0}
      />

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
    </View>
  );
}
