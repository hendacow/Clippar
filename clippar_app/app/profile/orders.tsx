import { useState, useEffect } from 'react';
import { View, Text, FlatList, ActivityIndicator, Linking, Alert } from 'react-native';
import { Stack, router } from 'expo-router';
import { Package, Truck, CheckCircle, Clock } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { getHardwareOrders } from '@/lib/api';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Pending', color: theme.colors.processing, icon: Clock },
  paid: { label: 'Paid', color: theme.colors.primary, icon: CheckCircle },
  shipped: { label: 'Shipped', color: theme.colors.accentBlue, icon: Truck },
  delivered: { label: 'Delivered', color: theme.colors.primary, icon: Package },
};

export default function OrdersScreen() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHardwareOrders()
      .then((data) => setOrders(data ?? []))
      // A failed fetch renders as "No orders yet", which is a lie to anyone who
      // has ordered. Keep the empty list — an error screen for a v1 where the
      // Shop is off would be noise — but log the cause rather than dropping it,
      // so a support report has something behind it.
      .catch((err) => {
        console.error('[Orders] failed to load hardware orders:', err);
        setOrders([]);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Orders' }} />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Orders' }} />
      <View style={{ flex: 1, padding: 16 }}>
        {orders.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
            <Package size={48} color={theme.colors.textTertiary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 16 }}>No orders yet</Text>
            {/* The ONLY remaining route into the Shop, so it carries the same
                switch the tab bar does. app/(tabs)/_layout.tsx cannot hide it
                for us: `href: null` drops the tab button but leaves the route
                registered, so this push reached a live storefront whose Buy Now
                fails while create-payment-intent is undeployed. Gated on the
                shared flag, not a copy of the literal, so turning the Shop back
                on stays one edit in constants/config.ts. */}
            {config.shop.inAppShopEnabled && (
              <Button
                title="Shop Clippar Kit"
                onPress={() => router.push('/(tabs)/shop')}
              />
            )}
          </View>
        ) : (
          <FlatList
            data={orders}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ gap: 12 }}
            renderItem={({ item }) => {
              const status = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.pending;
              const StatusIcon = status.icon;
              const date = new Date(item.created_at).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              });

              return (
                <Card style={{ gap: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700' }}>
                      {item.kit_type === 'premium' ? 'Premium Kit' : 'Standard Kit'}
                    </Text>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: theme.radius.full,
                        backgroundColor: `${status.color}20`,
                      }}
                    >
                      <StatusIcon size={12} color={status.color} />
                      <Text style={{ color: status.color, fontSize: 11, fontWeight: '600' }}>
                        {status.label}
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{date}</Text>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' }}>
                      ${((item.amount_cents ?? 0) / 100).toFixed(2)} AUD
                    </Text>
                  </View>

                  {item.tracking_number && (
                    <Button
                      title={`Track: ${item.tracking_number}`}
                      variant="ghost"
                      onPress={() => {
                        // openURL REJECTS when nothing can handle the link.
                        // Unhandled, the tap just does nothing and the row
                        // reads as broken — same guard as the mailto in
                        // app/(tabs)/profile.tsx. The tracking number is the
                        // useful part, so hand it over in the fallback.
                        Linking.openURL(
                          `https://auspost.com.au/mypost/track/#/details/${item.tracking_number}`
                        ).catch((err) => {
                          console.error('[Orders] failed to open tracking link:', err);
                          Alert.alert(
                            'Could not open tracking',
                            `Track this parcel at auspost.com.au with tracking number ${item.tracking_number}.`
                          );
                        });
                      }}
                    />
                  )}
                </Card>
              );
            }}
          />
        )}
      </View>
    </>
  );
}
