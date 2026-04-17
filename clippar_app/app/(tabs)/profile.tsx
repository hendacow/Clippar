import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Image } from 'expo-image';
import {
  User,
  Bluetooth,
  Bell,
  CreditCard,
  LogOut,
  ChevronRight,
  Crown,
  Settings,
  Trash2,
  MessageSquare,
  Star,
  HelpCircle,
  Edit2,
  Film,
  MapPin,
  Hash,
  Ruler,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { getProfile, getRounds } from '@/lib/api';

interface ProfileRow {
  display_name: string | null;
  email: string | null;
  handicap: number | null;
  home_course: string | null;
  avatar_url: string | null;
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
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          backgroundColor: theme.colors.surface,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '500' }}>
          {title}
        </Text>
        {subtitle && (
          <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing ?? <ChevronRight size={18} color={theme.colors.textTertiary} />}
    </Pressable>
  );
}

function Divider() {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: theme.colors.surfaceBorder,
        marginHorizontal: 16,
      }}
    />
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { status: subscriptionStatus } = useSubscription();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [useMeters, setUseMeters] = useState(true);
  const [roundsCount, setRoundsCount] = useState(0);
  const [draftCount, setDraftCount] = useState(0);

  // Reload profile + round counts every time the tab is focused
  useFocusEffect(
    useCallback(() => {
      getProfile()
        .then((data) => setProfile(data as ProfileRow))
        .catch(() => {});

      getRounds()
        .then((data) => {
          if (data) {
            setRoundsCount(data.length);
            setDraftCount(
              data.filter((r: any) => r.status !== 'ready' && r.status !== 'failed').length
            );
          }
        })
        .catch(() => {});
    }, [])
  );

  const rawName = profile?.display_name || user?.user_metadata?.full_name || 'Golfer';
  const displayName = rawName.trim() || 'Golfer';
  const avatarInitial = (displayName[0] ?? 'G').toUpperCase();
  const avatarUrl = profile?.avatar_url || null;

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
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: 16 }}>
          {/* ---- PROFILE HEADER ---- */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            {/* Avatar */}
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/profile/edit');
              }}
            >
              <View
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: 30,
                  backgroundColor: theme.colors.surface,
                  borderWidth: 2,
                  borderColor: theme.colors.surfaceBorder,
                  justifyContent: 'center',
                  alignItems: 'center',
                  overflow: 'hidden',
                }}
              >
                {avatarUrl ? (
                  <Image
                    source={{ uri: avatarUrl }}
                    style={{ width: 60, height: 60 }}
                    contentFit="cover"
                  />
                ) : (
                  <Text style={{ fontSize: 24, fontWeight: '800', color: theme.colors.primary }}>
                    {avatarInitial}
                  </Text>
                )}
              </View>
            </Pressable>

            {/* Name + details */}
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontSize: 24,
                  fontWeight: '800',
                  letterSpacing: -0.5,
                }}
              >
                {displayName}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
                {profile?.handicap != null && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Hash size={12} color={theme.colors.textTertiary} />
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                      {profile.handicap} hcp
                    </Text>
                  </View>
                )}
                {profile?.home_course && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <MapPin size={12} color={theme.colors.textTertiary} />
                    <Text
                      style={{ color: theme.colors.textSecondary, fontSize: 13 }}
                      numberOfLines={1}
                    >
                      {profile.home_course}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* Edit button */}
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/profile/edit');
              }}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                backgroundColor: theme.colors.surfaceElevated,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Edit2 size={16} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          {/* ---- PRO UPSELL CARD ---- */}
          {subscriptionStatus !== 'active' && (
            <Card
              style={{
                marginBottom: 20,
                paddingVertical: 20,
                paddingHorizontal: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: theme.colors.primaryMuted,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Crown size={24} color={theme.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: theme.colors.primary,
                    fontWeight: '800',
                    fontSize: 17,
                  }}
                >
                  Clippar Pro
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 13,
                    marginTop: 2,
                  }}
                >
                  Unlimited highlight reels & exports
                </Text>
              </View>
              <Pressable
                onPress={() => Haptics.selectionAsync()}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: theme.radius.md,
                  backgroundColor: theme.colors.primary,
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
                  Go Pro
                </Text>
              </Pressable>
            </Card>
          )}

          {/* ---- MAIN SETTINGS ---- */}
          <Card style={{ marginBottom: 16, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<Film size={18} color={theme.colors.primary} />}
              title="My Rounds"
              subtitle="Drafts, processing & completed reels"
              onPress={() => router.push('/profile/rounds')}
              trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {draftCount > 0 && (
                    <View
                      style={{
                        backgroundColor: theme.colors.processing + '20',
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: theme.radius.full,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.processing,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        {draftCount} active
                      </Text>
                    </View>
                  )}
                  <View
                    style={{
                      backgroundColor: theme.colors.surfaceBorder,
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: theme.radius.full,
                    }}
                  >
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                      {roundsCount}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={theme.colors.textTertiary} />
                </View>
              }
            />
            <Divider />
            <SettingsRow
              icon={<Bluetooth size={18} color={theme.colors.accentBlue} />}
              title="Bluetooth Clicker"
              subtitle="Manage clicker connection"
              onPress={() => router.push('/profile/bluetooth')}
            />
            <Divider />
            <SettingsRow
              icon={<Settings size={18} color={theme.colors.textSecondary} />}
              title="Settings"
              onPress={() => router.push('/profile/notifications')}
            />
          </Card>

          {/* ---- UNITS ---- */}
          <Card style={{ marginBottom: 16, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<Ruler size={18} color={theme.colors.textSecondary} />}
              title="Units"
              trailing={
                <View
                  style={{
                    flexDirection: 'row',
                    borderRadius: 8,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: theme.colors.surfaceBorder,
                  }}
                >
                  <Pressable
                    onPress={() => setUseMeters(false)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      backgroundColor: !useMeters ? theme.colors.surfaceElevated : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        color: !useMeters ? theme.colors.textPrimary : theme.colors.textTertiary,
                        fontSize: 13,
                        fontWeight: '600',
                      }}
                    >
                      Yards
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setUseMeters(true)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      backgroundColor: useMeters ? theme.colors.surfaceElevated : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        color: useMeters ? theme.colors.textPrimary : theme.colors.textTertiary,
                        fontSize: 13,
                        fontWeight: '600',
                      }}
                    >
                      Meters
                    </Text>
                  </Pressable>
                </View>
              }
            />
          </Card>

          {/* ---- SECONDARY SETTINGS ---- */}
          <Card style={{ marginBottom: 16, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<Bell size={18} color={theme.colors.processing} />}
              title="Notifications"
              subtitle="Reel ready, shipping updates"
              onPress={() => router.push('/profile/notifications')}
            />
            <Divider />
            <SettingsRow
              icon={<CreditCard size={18} color={theme.colors.primary} />}
              title="Orders"
              subtitle="Hardware kit order status"
              onPress={() => router.push('/profile/orders')}
            />
            <Divider />
            <SettingsRow
              icon={<Trash2 size={18} color={theme.colors.textTertiary} />}
              title="Clear Cache"
              subtitle="Free up space from thumbnails"
              onPress={() => {
                Haptics.selectionAsync();
                Alert.alert(
                  'Clear Cache',
                  'Cached thumbnails and temp files will be removed. Your rounds and reels stay safe.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Clear',
                      style: 'destructive',
                      onPress: () => {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      },
                    },
                  ]
                );
              }}
            />
          </Card>

          {/* ---- SUPPORT ---- */}
          <Card style={{ marginBottom: 24, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<HelpCircle size={18} color={theme.colors.textTertiary} />}
              title="Tutorials"
              subtitle="Coming soon"
              onPress={() => {
                Haptics.selectionAsync();
                Alert.alert('Coming Soon', 'In-app tutorials are on the way.');
              }}
            />
            <Divider />
            <SettingsRow
              icon={<Star size={18} color={theme.colors.accentGold} />}
              title="Rate Clippar"
              subtitle="Coming soon"
              onPress={() => {
                Haptics.selectionAsync();
                Alert.alert('Coming Soon', "We'll wire this up when we're live on the App Store.");
              }}
            />
            <Divider />
            <SettingsRow
              icon={<MessageSquare size={18} color={theme.colors.textTertiary} />}
              title="Feedback"
              subtitle="Email us at support@clippar.com"
              onPress={() => {
                Haptics.selectionAsync();
                Alert.alert(
                  'Send Feedback',
                  'Email support@clippar.com with your thoughts. We read every one.'
                );
              }}
            />
          </Card>

          {/* ---- SIGN OUT ---- */}
          <Button
            title="Sign Out"
            onPress={handleSignOut}
            variant="ghost"
            icon={<LogOut size={18} color={theme.colors.textSecondary} />}
          />

          {/* App version */}
          <Text
            style={{
              color: theme.colors.textTertiary,
              fontSize: 11,
              textAlign: 'center',
              marginTop: 16,
            }}
          >
            Clippar v1.0.0
          </Text>
        </View>
      </ScrollView>
    </GradientBackground>
  );
}
