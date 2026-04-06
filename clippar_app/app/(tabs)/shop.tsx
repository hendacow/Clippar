import { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Platform, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Package,
  Truck,
  ShieldCheck,
  Check,
  Smartphone,
  Zap,
  Battery,
  Bluetooth,
  Star,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { initPaymentSheet, presentPaymentSheet } from '@/lib/stripe';
import { getHardwareOrder } from '@/lib/api';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type KitType = 'standard' | 'premium';

const KITS = {
  standard: {
    name: 'Standard Kit',
    price: 59,
    tagline: 'Everything you need to get started',
    items: [
      {
        icon: Smartphone,
        title: 'Universal Buggy Mount',
        desc: 'Adjustable clamp fits any golf buggy rail. Holds phones up to 6.9".',
      },
      {
        icon: Bluetooth,
        title: 'BLE Shot Clicker',
        desc: 'Belt-clip remote with 1-year CR2032 battery. One-tap shot marking.',
      },
    ],
  },
  premium: {
    name: 'Premium Kit',
    price: 69,
    tagline: 'Standard Kit + wireless charging convenience',
    items: [
      {
        icon: Smartphone,
        title: 'Universal Buggy Mount',
        desc: 'Adjustable clamp fits any golf buggy rail. Holds phones up to 6.9".',
      },
      {
        icon: Bluetooth,
        title: 'BLE Shot Clicker',
        desc: 'Belt-clip remote with 1-year CR2032 battery. One-tap shot marking.',
      },
      {
        icon: Zap,
        title: 'MagSafe Charging Pad',
        desc: '15W wireless charger. Keep your phone topped up between rounds.',
      },
    ],
  },
} as const;

const SELLING_POINTS = [
  { icon: Battery, text: '12-month clicker battery life' },
  { icon: Star, text: 'Designed for Australian courses' },
  { icon: Truck, text: 'Free shipping Australia-wide' },
  { icon: ShieldCheck, text: '30-day satisfaction guarantee' },
];

export default function ShopScreen() {
  const insets = useSafeAreaInsets();
  const [selectedKit, setSelectedKit] = useState<KitType>('standard');
  const [purchasing, setPurchasing] = useState(false);
  const [existingOrder, setExistingOrder] = useState<any>(null);

  useEffect(() => {
    getHardwareOrder().then(setExistingOrder).catch(() => {});
  }, []);

  const kit = KITS[selectedKit];

  const handlePurchase = async () => {
    if (!isNative) {
      Alert.alert('Device Required', 'Purchases are only available on the mobile app.');
      return;
    }

    setPurchasing(true);
    try {
      const amount =
        selectedKit === 'standard'
          ? config.hardware.standardPriceCents
          : config.hardware.premiumPriceCents;

      await initPaymentSheet({
        amount,
        currency: config.hardware.currency,
        productType: selectedKit,
      });

      const success = await presentPaymentSheet();
      if (success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Order Placed!', 'Your Clippar Kit is on its way. Check Orders in your Profile for tracking.');
        getHardwareOrder().then(setExistingOrder).catch(() => {});
      }
    } catch (error) {
      Alert.alert('Payment Failed', (error as Error).message);
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <GradientBackground>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: 16 }}>
          {/* Header */}
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 4 }}>
            Clippar Kit
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 24 }}>
            Mount your phone, clip your shots, relive every round.
          </Text>

          {/* Product hero */}
          <View
            style={{
              height: 220,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.xl,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 24,
              overflow: 'hidden',
            }}
          >
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Package size={56} color={theme.colors.primary} strokeWidth={1.5} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700' }}>
                {kit.name}
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                {kit.tagline}
              </Text>
            </View>
          </View>

          {/* Selling points row */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12, paddingBottom: 4 }}
            style={{ marginBottom: 24 }}
          >
            {SELLING_POINTS.map((point, i) => {
              const Icon = point.icon;
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    backgroundColor: theme.colors.surface,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: theme.radius.full,
                    borderWidth: 1,
                    borderColor: theme.colors.surfaceBorder,
                  }}
                >
                  <Icon size={14} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>
                    {point.text}
                  </Text>
                </View>
              );
            })}
          </ScrollView>

          {/* Kit selection */}
          <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary, marginBottom: 12 }}>
            Choose Your Kit
          </Text>

          {(['standard', 'premium'] as const).map((type) => {
            const isSelected = selectedKit === type;
            const kitInfo = KITS[type];
            return (
              <Pressable
                key={type}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSelectedKit(type);
                }}
              >
                <Card
                  style={{
                    marginBottom: 12,
                    borderColor: isSelected ? theme.colors.primary : theme.colors.surfaceBorder,
                    borderWidth: isSelected ? 2 : 1,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 16 }}>
                          {kitInfo.name}
                        </Text>
                        {type === 'premium' && (
                          <View
                            style={{
                              backgroundColor: theme.colors.accentGold + '20',
                              paddingHorizontal: 8,
                              paddingVertical: 2,
                              borderRadius: theme.radius.full,
                            }}
                          >
                            <Text style={{ color: theme.colors.accentGold, fontSize: 10, fontWeight: '700' }}>
                              BEST VALUE
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
                        {kitInfo.tagline}
                      </Text>
                    </View>
                    <Text style={{ color: theme.colors.primary, fontWeight: '800', fontSize: 24 }}>
                      ${kitInfo.price}
                    </Text>
                  </View>

                  {/* Selection indicator */}
                  <View
                    style={{
                      position: 'absolute',
                      top: 12,
                      right: 12,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      borderWidth: 2,
                      borderColor: isSelected ? theme.colors.primary : theme.colors.surfaceBorder,
                      backgroundColor: isSelected ? theme.colors.primary : 'transparent',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    {isSelected && <Check size={12} color="#FFFFFF" strokeWidth={3} />}
                  </View>
                </Card>
              </Pressable>
            );
          })}

          {/* What's included */}
          <Text
            style={{ ...theme.typography.h3, color: theme.colors.textPrimary, marginTop: 12, marginBottom: 16 }}
          >
            What's Included
          </Text>

          {kit.items.map((item, i) => {
            const Icon = item.icon;
            return (
              <View
                key={i}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 14,
                  marginBottom: 20,
                  paddingLeft: 4,
                }}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: theme.colors.primaryMuted,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <Icon size={20} color={theme.colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2, lineHeight: 18 }}>
                    {item.desc}
                  </Text>
                </View>
              </View>
            );
          })}

          {/* Shipping info */}
          <Card style={{ marginTop: 4, marginBottom: 24, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Truck size={20} color={theme.colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                Free Shipping Australia-wide
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                Ships within 3 business days via Australia Post
              </Text>
            </View>
          </Card>

          {/* Security badge */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              marginBottom: 24,
            }}
          >
            <ShieldCheck size={14} color={theme.colors.textTertiary} />
            <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
              Secure payment via Stripe
            </Text>
          </View>

          {existingOrder ? (
            <Card style={{ gap: 8, borderColor: theme.colors.primary, borderWidth: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Check size={18} color={theme.colors.primary} />
                <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: 16 }}>
                  Order {existingOrder.status === 'paid' ? 'Confirmed' : existingOrder.status}
                </Text>
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                {existingOrder.product_type === 'premium' ? 'Premium' : 'Standard'} Kit &middot;{' '}
                {new Date(existingOrder.created_at).toLocaleDateString('en-AU')}
              </Text>
            </Card>
          ) : (
            <Button
              title={`Buy Now — $${kit.price} AUD`}
              onPress={handlePurchase}
              loading={purchasing}
            />
          )}
        </View>
      </ScrollView>
    </GradientBackground>
  );
}
