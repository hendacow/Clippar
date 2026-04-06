import { useRef, useEffect, useCallback } from 'react';
import { View, Text, Pressable, Linking } from 'react-native';
import { Lock, ExternalLink, RefreshCw, X } from 'lucide-react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { Button } from '@/components/ui/Button';

interface SubscriptionPaywallProps {
  visible: boolean;
  onDismiss: () => void;
  onRefresh?: () => void;
}

export function SubscriptionPaywall({
  visible,
  onDismiss,
  onRefresh,
}: SubscriptionPaywallProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  const monthlyPrice = (config.subscription.monthlyPriceAud / 100).toFixed(2);
  const annualPrice = (config.subscription.annualPriceAud / 100).toFixed(2);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={['55%']}
      enablePanDownToClose
      onClose={handleClose}
      backgroundStyle={{ backgroundColor: theme.colors.surfaceElevated }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ flex: 1, padding: 24 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Lock size={20} color={theme.colors.accent} />
            <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary }}>
              Subscription Required
            </Text>
          </View>
          <Pressable onPress={onDismiss} hitSlop={12}>
            <X size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 24 }}>
          Recording and processing rounds requires an active Clippar subscription.
        </Text>

        {/* Pricing */}
        <View style={{ gap: 12, marginBottom: 24 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 14,
              backgroundColor: theme.colors.primaryMuted,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.primary,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Monthly</Text>
            <Text style={{ color: theme.colors.primary, fontWeight: '800', fontSize: 18 }}>
              ${monthlyPrice}/mo
            </Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 14,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Annual</Text>
            <Text style={{ color: theme.colors.primary, fontWeight: '800', fontSize: 18 }}>
              ${annualPrice}/yr
            </Text>
          </View>
        </View>

        <Button
          title="Subscribe at clippargolf.com"
          onPress={() => Linking.openURL(config.subscription.websiteUrl)}
          icon={<ExternalLink size={16} color="#FFFFFF" />}
        />

        {onRefresh && (
          <Pressable
            onPress={onRefresh}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              marginTop: 16,
              paddingVertical: 12,
            }}
          >
            <RefreshCw size={14} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>
              Already subscribed? Tap to refresh
            </Text>
          </Pressable>
        )}
      </BottomSheetView>
    </BottomSheet>
  );
}
