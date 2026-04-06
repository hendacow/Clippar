import { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  User,
  Bluetooth,
  Bell,
  CreditCard,
  LogOut,
  ChevronRight,
  Crown,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { getProfile } from '@/lib/api';

interface ProfileRow {
  display_name: string | null;
  email: string | null;
  handicap: number | null;
  home_course: string | null;
  subscription_status: string;
}

function SettingsRow({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '500' }}>
          {title}
        </Text>
        {subtitle && (
          <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{subtitle}</Text>
        )}
      </View>
      {trailing ?? <ChevronRight size={18} color={theme.colors.textTertiary} />}
    </Pressable>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { status: subscriptionStatus } = useSubscription();
  const [profile, setProfile] = useState<ProfileRow | null>(null);

  useEffect(() => {
    getProfile()
      .then((data) => setProfile(data as ProfileRow))
      .catch(() => {});
  }, []);

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <GradientBackground>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 120 }}
      >
        <View style={{ paddingHorizontal: 16 }}>
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 24 }}>
            Profile
          </Text>

          {/* User info card */}
          <Card style={{ marginBottom: 24, alignItems: 'center', paddingVertical: 24 }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: theme.colors.primaryMuted,
                justifyContent: 'center',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <User size={32} color={theme.colors.primary} />
            </View>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 20 }}>
              {profile?.display_name ?? 'Golfer'}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 4 }}>
              {user?.email ?? ''}
            </Text>

            {/* Subscription badge */}
            <View
              style={{
                marginTop: 12,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: theme.radius.full,
                backgroundColor:
                  subscriptionStatus === 'active'
                    ? theme.colors.primaryMuted
                    : 'rgba(255, 152, 0, 0.15)',
              }}
            >
              <Crown
                size={14}
                color={subscriptionStatus === 'active' ? theme.colors.primary : theme.colors.processing}
              />
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: subscriptionStatus === 'active' ? theme.colors.primary : theme.colors.processing,
                }}
              >
                {subscriptionStatus === 'active'
                  ? 'Pro Subscriber'
                  : subscriptionStatus === 'trial'
                    ? 'Trial'
                    : 'Free Plan'}
              </Text>
            </View>

            {subscriptionStatus !== 'active' && (
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  marginTop: 12,
                  textAlign: 'center',
                }}
              >
                Subscribe at clippargolf.com to unlock all features
              </Text>
            )}
          </Card>

          {/* Settings */}
          <Card style={{ marginBottom: 24, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<Bluetooth size={20} color={theme.colors.accentBlue} />}
              title="Bluetooth Clicker"
              subtitle="Manage clicker connection"
              onPress={() => router.push('/profile/bluetooth')}
            />
            <View style={{ height: 1, backgroundColor: theme.colors.surfaceBorder, marginHorizontal: 16 }} />
            <SettingsRow
              icon={<Bell size={20} color={theme.colors.processing} />}
              title="Notifications"
              subtitle="Reel ready, shipping updates"
              onPress={() => router.push('/profile/notifications')}
            />
            <View style={{ height: 1, backgroundColor: theme.colors.surfaceBorder, marginHorizontal: 16 }} />
            <SettingsRow
              icon={<CreditCard size={20} color={theme.colors.primary} />}
              title="Orders"
              subtitle="Hardware kit order status"
              onPress={() => router.push('/profile/orders')}
            />
          </Card>

          <Button
            title="Sign Out"
            onPress={handleSignOut}
            variant="ghost"
            icon={<LogOut size={18} color={theme.colors.textSecondary} />}
          />
        </View>
      </ScrollView>
    </GradientBackground>
  );
}
