import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Switch, Linking } from 'react-native';
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
  ShieldCheck,
  Activity,
  HardDrive,
  Radar,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { getProfile, getRounds, deleteAccount } from '@/lib/api';
import { iap } from '@/lib/iap';
import { verifyAllRoundsReachable } from '@/lib/verifyRound';
import { processUploadQueue } from '@/lib/uploadQueue';
import { isConnected } from '@/lib/network';
import { wipeLocalUserData } from '@/lib/localWipe';
import { supabase } from '@/lib/supabase';
import { variantIsDev } from '@/lib/variant';

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
  const { replayOnboarding } = useOnboarding();
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

  // App Review 5.1.1(v): account deletion must be initiated fully in-app.
  // Two-step confirm — the second alert spells out exactly what is destroyed.
  const [deletingAccount, setDeletingAccount] = useState(false);

  const runAccountDeletion = useCallback(async () => {
    if (deletingAccount) return;
    setDeletingAccount(true);
    try {
      // Deletion needs connectivity — it calls the delete-account Edge
      // Function. Block clearly rather than half-deleting or hanging.
      if (!(await isConnected())) {
        Alert.alert(
          'You’re offline',
          'Deleting your account needs an internet connection so we can erase your data from our servers. Reconnect and try again.'
        );
        return;
      }

      // Re-auth gate: refresh the session so the JWT the Edge Function will
      // verify is current. If the refresh token is stale/expired we can't
      // prove who the caller is — make them sign in again before deleting.
      const { data: refreshed, error: refreshError } =
        await supabase.auth.refreshSession();
      if (refreshError || !refreshed?.session) {
        Alert.alert(
          'Please sign in again',
          'Your session has expired. For your security, sign in again and then delete your account.',
          [
            {
              text: 'Sign in',
              onPress: async () => {
                await signOut().catch(() => {});
                router.replace('/(auth)/login');
              },
            },
          ]
        );
        return;
      }

      await deleteAccount();
      // Detach the RevenueCat customer so the deleted user's purchases don't
      // stay aliased to a dead account, clearing the local Pro entitlement.
      // NOTE: this does NOT cancel an Apple subscription — Apple only lets the
      // USER do that in Settings (handled by the warning step before here).
      await iap.reset().catch(() => {});
      // Erase local SQLite (rounds/clips/scores/queue/settings) + secure-store
      // so the next sign-in on this device starts clean.
      await wipeLocalUserData();
      await signOut();
      router.replace('/(auth)/login');
    } catch {
      Alert.alert(
        'Deletion failed',
        'Something went wrong deleting your account. Please try again, or email support@clippar.com and we will delete it for you.'
      );
    } finally {
      setDeletingAccount(false);
    }
  }, [deletingAccount, signOut]);

  const confirmFinalDeletion = useCallback(async () => {
    // If there's a live auto-renewing App Store subscription, deletion can't
    // stop Apple from billing — only the user can cancel in iOS Settings.
    // Warn explicitly and offer the manage-subscriptions shortcut.
    const hasSub = await iap.hasActiveStoreSubscription().catch(() => false);
    if (hasSub) {
      Alert.alert(
        'Cancel your subscription first',
        'Deleting your account does NOT cancel your Clippar Pro subscription — Apple will keep charging you until you cancel it in your iPhone Settings. Open Settings to cancel, then come back to delete your account.',
        [
          { text: 'Open Settings', onPress: () => Linking.openURL('https://apps.apple.com/account/subscriptions') },
          {
            text: 'Delete anyway',
            style: 'destructive',
            onPress: runAccountDeletion,
          },
          { text: 'Keep my account', style: 'cancel' },
        ]
      );
      return;
    }
    runAccountDeletion();
  }, [runAccountDeletion]);

  const handleDeleteAccount = async () => {
    if (deletingAccount) return;
    // Bail before the destructive confirm dialogs if we're obviously offline —
    // deletion can't complete without reaching the server.
    if (!(await isConnected())) {
      Alert.alert(
        'You’re offline',
        'Deleting your account needs an internet connection so we can erase your data from our servers. Reconnect and try again.'
      );
      return;
    }
    Alert.alert(
      'Delete Account?',
      'This permanently deletes your account, all rounds, clips, and highlight reels from Clippar. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Are you absolutely sure?',
              'Your videos saved to your Photos library stay on your phone, but everything in your Clippar account is erased forever.',
              [
                { text: 'Keep my account', style: 'cancel' },
                {
                  text: 'Delete everything',
                  style: 'destructive',
                  onPress: confirmFinalDeletion,
                },
              ]
            ),
        },
      ]
    );
  };

  // Debug: smoke-test reachability of every round in Supabase so the user
  // can confirm their videos would survive a reinstall / cross-device sign-in.
  const [verifying, setVerifying] = useState(false);
  const handleVerifyRounds = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    Haptics.selectionAsync();
    try {
      // Flush any pending uploads first so the check isn't racing the queue.
      void processUploadQueue();
      const reports = await verifyAllRoundsReachable();
      const failing = reports.filter((r) => !r.ok);
      if (reports.length === 0) {
        Alert.alert('Verify Rounds', 'No rounds found in Supabase.');
      } else if (failing.length === 0) {
        Alert.alert(
          'All Rounds Reachable',
          `Checked ${reports.length} round(s). All videos would play on a fresh install.`
        );
      } else {
        const lines = failing
          .slice(0, 5)
          .map(
            (r) =>
              `• ${r.courseName ?? r.roundId.slice(0, 8)}: ${r.issues.join(', ')}`
          )
          .join('\n');
        const more =
          failing.length > 5 ? `\n…and ${failing.length - 5} more` : '';
        Alert.alert(
          `${failing.length}/${reports.length} rounds have issues`,
          `${lines}${more}`
        );
      }
    } catch (err) {
      Alert.alert(
        'Verify Failed',
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    } finally {
      setVerifying(false);
    }
  }, [verifying]);

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
                onPress={() => {
                  Haptics.selectionAsync();
                  router.push('/paywall');
                }}
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
              title="Trim Settings"
              subtitle="Auto-trim, timing, quality"
              onPress={() => router.push('/profile/trim-settings')}
            />
            <Divider />
            <SettingsRow
              icon={<HardDrive size={18} color={theme.colors.textSecondary} />}
              title="Storage & Backup"
              subtitle="Photos mirroring, cloud backup, cache"
              onPress={() => router.push('/profile/storage-settings')}
            />
            {/* Debug harnesses: dev builds only — App Review rejects visible
                developer UI in production (2.2 beta/demo content). */}
            {__DEV__ && (
              <>
                <Divider />
                <SettingsRow
                  icon={<Activity size={18} color={theme.colors.textSecondary} />}
                  title="Trim Sandbox (debug)"
                  subtitle="Pick a video, see auto-trim output instantly"
                  onPress={() => router.push('/profile/trim-sandbox')}
                />
                <Divider />
                <SettingsRow
                  icon={<Activity size={18} color={theme.colors.textSecondary} />}
                  title="Tracer Sim (debug)"
                  subtitle="Synthetic GPS shots → rendered tracer arcs"
                  onPress={() => router.push('/(dev)/tracer-sim')}
                />
              </>
            )}
            {/* S11: tracer field-testing knobs — hidden unless variantIsDev()
                (the clippar-dev build variant), not just any __DEV__ build. */}
            {variantIsDev() && (
              <>
                <Divider />
                <SettingsRow
                  icon={<Radar size={18} color={theme.colors.textSecondary} />}
                  title="Tracer Dev Settings"
                  subtitle="On/off, default carry, debug bypasses"
                  onPress={() => router.push('/profile/tracer-dev-settings')}
                />
              </>
            )}
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
              icon={<HelpCircle size={18} color={theme.colors.primary} />}
              title="Show me around again"
              subtitle="Replay the welcome tour"
              onPress={async () => {
                Haptics.selectionAsync();
                // Navigate to home BEFORE resetting flags — the tour's
                // spotlight targets (record-button, import-card, rounds-list)
                // all live on the Home tab, not Profile. Otherwise the tour
                // opens on an empty Profile screen with no targets registered.
                router.replace('/(tabs)');
                // Give the Home tab a frame to mount + register its targets
                // before we flip the flags that trigger the tour.
                requestAnimationFrame(() => {
                  void replayOnboarding();
                });
              }}
            />
            <Divider />
            <SettingsRow
              icon={<Activity size={18} color={theme.colors.primary} />}
              title="Diagnostics"
              subtitle="Data integrity, upload queue, reachability"
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/profile/diagnostics');
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
            <Divider />
            <SettingsRow
              icon={<ShieldCheck size={18} color={theme.colors.primary} />}
              title={verifying ? 'Verifying Rounds…' : 'Verify My Rounds'}
              subtitle="Check every round is playable after reinstall"
              onPress={handleVerifyRounds}
            />
          </Card>

          {/* ---- LEGAL (App Review 5.1.1: privacy policy must be reachable
                in-app; pairs with the App Store Connect metadata URL) ---- */}
          <Card style={{ marginBottom: 16, paddingVertical: 4, paddingHorizontal: 0 }}>
            <SettingsRow
              icon={<ShieldCheck size={18} color={theme.colors.textTertiary} />}
              title="Privacy Policy"
              onPress={() => Linking.openURL('https://clippargolf.com/privacy')}
            />
            <Divider />
            <SettingsRow
              icon={<HelpCircle size={18} color={theme.colors.textTertiary} />}
              title="Terms of Service"
              onPress={() => Linking.openURL('https://clippargolf.com/terms')}
            />
          </Card>

          {/* ---- SIGN OUT ---- */}
          <Button
            title="Sign Out"
            onPress={handleSignOut}
            variant="ghost"
            icon={<LogOut size={18} color={theme.colors.textSecondary} />}
          />

          {/* ---- DELETE ACCOUNT (App Review 5.1.1(v)) ---- */}
          <Button
            title={deletingAccount ? 'Deleting Account…' : 'Delete Account'}
            onPress={handleDeleteAccount}
            variant="ghost"
            loading={deletingAccount}
            disabled={deletingAccount}
            textStyle={{ color: theme.colors.doubleBogey, fontWeight: '600' }}
            icon={<Trash2 size={18} color={theme.colors.doubleBogey} />}
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
