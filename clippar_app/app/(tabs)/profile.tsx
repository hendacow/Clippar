import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Switch, Linking, Platform } from 'react-native';
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
  HelpCircle,
  Edit2,
  Film,
  MapPin,
  Hash,
  Ruler,
  ShieldCheck,
  Activity,
  HardDrive,
  Ticket,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
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
import {
  wipeLocalUserData,
  clearAccountLinkedCaches,
  removeLocalMediaForCurrentUser,
} from '@/lib/localWipe';
import { clearDisposableCaches, formatBytes } from '@/lib/cacheReclaim';
import { supabase } from '@/lib/supabase';
import { SUPPORT_EMAIL } from '@/constants/support';

/**
 * Shown in the footer and stamped into the feedback subject line, so a support
 * email arrives already saying which build it came from — the first thing you
 * otherwise have to ask for. Read from app.config.js rather than typed out
 * twice, so bumping the release doesn't leave one of the two behind.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

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
  const { user, signOut, signInWithApple, signInWithGoogle } = useAuth();
  const { status: subscriptionStatus } = useSubscription();
  const { replayOnboarding } = useOnboarding();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  // useMeters/setUseMeters REMOVED with the Units toggle — see the note where
  // that card used to be. Nothing else read it.
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

  // Sign-out residue. Local video is NOT a cache in this app: for a golfer who
  // hasn't turned cloud backup on, documentDirectory/clips/ holds the only copy
  // of a round that cannot be re-recorded, so sign-out must never wipe it by
  // itself. What used to be wrong is that it cleared nothing AND scoped
  // nothing, so the next account on the handset was offered the previous
  // golfer's unfinished round and its playable clips. The rows are now scoped
  // to a user id (lib/localScope.ts); this gives the user the explicit choice
  // spec 5.5 asks for, for the case where the phone really is being handed on.
  const finishSignOut = useCallback(async () => {
    // Before the session goes away: the local store resolves "whose data is
    // this" from the session, so a clear that runs after signOut() clears
    // nothing.
    await clearAccountLinkedCaches().catch(() => {});
    await signOut();
    router.replace('/(auth)/login');
  }, [signOut]);

  const confirmSignOutAndRemoveMedia = useCallback(() => {
    Alert.alert(
      'Delete videos from this phone?',
      'Every Clippar round on this phone is deleted, including any that have not been backed up — those cannot be recovered. Videos you saved to your Photos library stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete & sign out',
          style: 'destructive',
          onPress: async () => {
            await removeLocalMediaForCurrentUser();
            await finishSignOut();
          },
        },
      ]
    );
  }, [finishSignOut]);

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Your rounds and videos stay on this phone, and whoever signs in next will not see them. If you are handing this phone on, you can remove them now.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove my videos too',
          style: 'destructive',
          onPress: confirmSignOutAndRemoveMedia,
        },
        {
          text: 'Sign Out',
          onPress: () => {
            void finishSignOut();
          },
        },
      ]
    );
  };

  // App Review 5.1.1(v): account deletion must be initiated fully in-app.
  // Two-step confirm — the second alert spells out exactly what is destroyed.
  const [deletingAccount, setDeletingAccount] = useState(false);

  /** iOS secure-text prompt, wrapped as a promise. null = the user cancelled. */
  const promptForPassword = () =>
    new Promise<string | null>((resolve) => {
      Alert.prompt(
        'Confirm it’s you',
        'Enter your Clippar password to delete your account. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          {
            text: 'Confirm',
            style: 'destructive',
            onPress: (value?: string) => resolve(value ?? ''),
          },
        ],
        'secure-text'
      );
    });

  /**
   * Recent-authentication gate for deletion.
   *
   * What stood here was `supabase.auth.refreshSession()` under a comment
   * calling itself a "Re-auth gate". It was not one: spending the stored
   * refresh token proves possession of a token the caller already had and asks
   * the human for nothing, so an unattended unlocked phone was two taps from
   * destroying the account, every round and every published reel, with no
   * undo and no confirmation email. Make the human prove they are the account
   * holder, now, using whatever provider the account signs in with.
   *
   * The identity re-check afterwards matters as much as the credential: a
   * bystander could otherwise authenticate with their OWN Apple/Google account
   * and have the session — and therefore the deletion — land somewhere nobody
   * intended.
   *
   * This is the client half only. It closes the unattended-device path. It
   * cannot close a stolen-token path, because an attacker holding the access
   * token POSTs delete-account directly and never runs this code; the Edge
   * Function needs its own freshness check on the verified JWT (tracked
   * separately — that file is outside this change).
   */
  const reauthenticate = useCallback(async (): Promise<boolean> => {
    const priorUserId = user?.id;
    // `providers` is the fallback because an account linked to Apple/Google
    // can arrive with `provider` unset, and defaulting that to 'email' would
    // demand a password the user has never had — locking them out of the
    // in-app deletion App Review 5.1.1(v) requires.
    const linked = (user?.app_metadata?.providers as string[] | undefined) ?? [];
    const provider =
      (user?.app_metadata?.provider as string | undefined) ?? linked[0] ?? 'email';
    try {
      if (provider === 'apple') {
        await signInWithApple();
      } else if (provider === 'google') {
        await signInWithGoogle();
      } else if (user?.email && Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
        const password = await promptForPassword();
        if (password === null) return false;
        const { error } = await supabase.auth.signInWithPassword({
          email: user.email,
          password,
        });
        if (error) {
          Alert.alert('That didn’t match', 'Your password was not correct, so nothing was deleted.');
          return false;
        }
      } else {
        // No way to challenge the user on this platform/account shape. Fail
        // CLOSED — send them through a real sign-in rather than deleting on
        // the strength of a session that has proven nothing.
        Alert.alert(
          'Sign in again first',
          'For your security we need you to sign in again before deleting your account.',
          [
            {
              text: 'Sign in',
              onPress: async () => {
                await signOut().catch(() => {});
                router.replace('/(auth)/login');
              },
            },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
        return false;
      }
    } catch (err) {
      // Dismissed Apple/Google sheet, cancelled prompt, network failure — none
      // of them are proof of identity.
      if (!(err instanceof Error && err.message === 'cancelled')) {
        Alert.alert(
          'Couldn’t confirm it’s you',
          'We couldn’t verify your sign-in, so nothing was deleted. Please try again.'
        );
      }
      return false;
    }

    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user || (priorUserId && data.user.id !== priorUserId)) {
      Alert.alert(
        'Different account',
        'That sign-in was for a different account, so nothing was deleted.'
      );
      return false;
    }
    return true;
  }, [user, signInWithApple, signInWithGoogle, signOut]);

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

      // Prove a HUMAN with the account's credential is present, right now.
      // Everything below this line is irreversible.
      if (!(await reauthenticate())) return;

      await deleteAccount();
      // Detach the RevenueCat customer so the deleted user's purchases don't
      // stay aliased to a dead account, clearing the local Pro entitlement.
      // NOTE: this does NOT cancel an Apple subscription — Apple only lets the
      // USER do that in Settings (handled by the warning step before here).
      await iap.reset().catch(() => {});
      // Erase local SQLite (rounds/clips/scores/queue/settings), the video
      // files those rows point at, our media directories and the secure-store
      // keys, so the next sign-in on this device starts clean. Runs BEFORE
      // signOut — the wipe resolves the user's rows from the live session.
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
  }, [deletingAccount, signOut, reauthenticate]);

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
              // Say plainly what happens to the on-device video (spec 6.7).
              // The old copy mentioned only the Photos-library carve-out, which
              // read as "your local footage is untouched" — while the wipe was
              // in fact dropping the rows and (until this change) orphaning the
              // files on disk forever. Both halves are now true and stated.
              'Everything in your Clippar account is erased forever, and every Clippar video on this phone is deleted with it. Copies you saved to your Photos library stay.',
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

  /**
   * Clear Cache. What stood here was a lone
   * `Haptics.notificationAsync(Success)` under copy promising "Cached
   * thumbnails and temp files will be removed" — it buzzed success and freed
   * nothing, which is both dishonest to a golfer hunting for storage and
   * exactly the kind of feature App Review 2.1 rejects for not doing what it
   * says. lib/cacheReclaim.ts now does the work, and carries the inventory of
   * what must never be swept (source clips, composed reels, the database).
   *
   * We report the byte count because that is what makes the claim checkable —
   * by the user, and by a reviewer. The three outcomes are kept distinct on
   * purpose: freed something, had nothing to free, or failed. Only the first
   * gets the success buzz.
   */
  const [clearingCache, setClearingCache] = useState(false);
  const runClearCache = useCallback(async () => {
    setClearingCache(true);
    try {
      const { bytesFreed, hadErrors } = await clearDisposableCaches();
      if (bytesFreed > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Cache Cleared', `Freed ${formatBytes(bytesFreed)}.`);
      } else if (hadErrors) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          'Couldn’t clear the cache',
          'Something went wrong, so nothing was freed. Your rounds and videos are untouched — please try again.'
        );
      } else {
        // Say so plainly. Buzzing success over a no-op is the bug being fixed.
        Alert.alert(
          'Nothing to clear',
          'There were no cached files to remove. Everything Clippar is storing right now is your rounds, clips and reels, and we will not delete those.'
        );
      }
    } catch {
      // clearDisposableCaches only rejects before it has deleted anything —
      // it refuses to sweep without knowing which files are still in use — so
      // "nothing was freed" is accurate here.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Couldn’t clear the cache',
        'Something went wrong, so nothing was freed. Your rounds and videos are untouched — please try again.'
      );
    } finally {
      setClearingCache(false);
    }
  }, []);

  const handleClearCache = useCallback(() => {
    if (clearingCache) return;
    Haptics.selectionAsync();
    Alert.alert(
      'Clear Cache',
      'Removes cached thumbnails and old temporary files. Your rounds, clips and highlight reels stay exactly where they are.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void runClearCache();
          },
        },
      ]
    );
  }, [clearingCache, runClearCache]);

  // Dev-only smoke test — see the __DEV__ gate on its row below for why it is
  // not shown to users. Reports raw round UUIDs and internal issue strings.
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
              title="Backup & status"
              subtitle="Drafts, backup progress & synced rounds"
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
            {/* Bluetooth Clicker HIDDEN for v1. The screen genuinely pairs and
                connects — and then nothing reads the connection, so a paired
                clicker cannot start or stop a recording. A control that
                completes a real-looking flow and still does nothing is worse
                than an absent one, and it is on the path a reviewer walks.
                The screen is left in place; restore this row once the clicker
                actually drives capture. */}
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
                <Divider />
                {/* The fastest way to tell whether swing-vision actually made
                    it into a build: it names which of the two failure modes
                    happened (native module didn't link vs model didn't load)
                    instead of silently falling back to shot-detector, which is
                    what every other surface does by design. */}
                <SettingsRow
                  icon={<Activity size={18} color={theme.colors.textSecondary} />}
                  title="Swing Vision (debug)"
                  subtitle="Pick a clip → the instant it thinks you swung"
                  onPress={() => router.push('/(dev)/swing-vision')}
                />
              </>
            )}
          </Card>

          {/* UNITS TOGGLE REMOVED for v1. Yards/Meters was backed by plain
              component state and read only to colour its own highlight: it did
              not persist across a restart and nothing consumed it. It could not
              have — the app renders no distance to a user anywhere (hole
              `length_meters` is carried through CourseSearch's data mapping and
              never reaches JSX). A units preference with no units on screen is
              a control that cannot work, so it is gone rather than wired to
              nothing. Bring it back with the first screen that shows a
              distance. */}
          {/* ---- SECONDARY SETTINGS ---- */}
          <Card style={{ marginBottom: 16, paddingVertical: 4, paddingHorizontal: 0 }}>
            {/* Notifications HIDDEN for v1 — the screen is dead twice over.
                Its three switches write to AsyncStorage and are read only to
                restore their own positions on mount, and the app has no
                notification machinery at all: expo-notifications appears
                nowhere in app/profile/notifications.tsx, no push token is ever
                requested, and nothing is ever sent. Promising "Reel ready,
                shipping updates" and delivering neither is a 2.3.1 problem as
                well as a dead control. Restore the row when notifications are
                actually wired. */}
            <SettingsRow
              icon={<CreditCard size={18} color={theme.colors.primary} />}
              title="Orders"
              subtitle="Hardware kit order status"
              onPress={() => router.push('/profile/orders')}
            />
            <Divider />
            {/* Ambassador / early-supporter lifetime codes. Shown to Pro users
                too: redeeming is idempotent for the same account, and someone
                who subscribed before their card arrived still needs somewhere
                to enter it. */}
            <SettingsRow
              icon={<Ticket size={18} color={theme.colors.accentGold} />}
              title="Redeem a code"
              subtitle="Turn a Clippar code into Pro for life"
              onPress={() => router.push('/profile/redeem')}
            />
            <Divider />
            <SettingsRow
              icon={<Trash2 size={18} color={theme.colors.textTertiary} />}
              title={clearingCache ? 'Clearing Cache…' : 'Clear Cache'}
              subtitle="Remove thumbnails and old temporary files"
              onPress={handleClearCache}
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
            {/* Internal support tool: dev builds only — App Review reads a
                data-integrity/queue inspector as unfinished developer UI
                (2.1 / 4.0), and it means nothing to a golfer. */}
            {__DEV__ && (
              <>
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
              </>
            )}
            {/* There is deliberately no "Rate Clippar" row. It shipped as a
                placeholder — subtitle "Coming soon", alert "We'll wire this up
                when we're live on the App Store" — which is a visible
                non-functional feature (App Review 2.1: placeholder and other
                temporary content must be scrubbed before submission), and an
                odd thing to show the reviewer deciding whether to put us there.
                Deleted rather than __DEV__-gated: unlike Diagnostics above, it
                has no internal use to preserve.

                To build the real thing later, do NOT reinstate this row —
                add expo-store-review and call StoreReview.requestReview()
                behind `await StoreReview.isAvailableAsync()`. iOS rate-limits
                the system prompt, so it must never be the only affordance nor
                be presented as a guaranteed action. */}
            <Divider />
            <SettingsRow
              icon={<MessageSquare size={18} color={theme.colors.textTertiary} />}
              title="Feedback"
              subtitle={`Email us at ${SUPPORT_EMAIL}`}
              onPress={() => {
                Haptics.selectionAsync();
                // openURL REJECTS when the device has no mail client — the norm
                // on a simulator and on any phone with no Mail account set up.
                // Fall back to telling them the address rather than letting the
                // rejection go unhandled and the tap do nothing.
                Linking.openURL(
                  `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                    `Clippar feedback (v${APP_VERSION})`
                  )}`
                ).catch(() => {
                  Alert.alert(
                    'Send Feedback',
                    `No mail app is set up on this device. Email ${SUPPORT_EMAIL} with your thoughts — we read every one.`
                  );
                });
              }}
            />
            {/* Internal smoke test: dev builds only, for the same reasons as
                Diagnostics above, plus one specific to this check. It asks
                Supabase whether every round's clips and reel can be signed —
                i.e. it measures the CLOUD. Cloud backup is off by default and
                Pro-gated, so on a normal free account the raw clips were never
                uploaded and this reports every round as broken. That is a false
                alarm dressed as a data-loss warning, on top of showing raw
                round UUIDs, internal issue strings and the backend's name.
                The genuine user question behind it — "will my videos survive a
                reinstall?" — is already answered honestly, per setting, by the
                "What happens if I uninstall Clippar?" card in
                app/profile/storage-settings.tsx, one tap away on this screen.
                The Divider lives inside the gate so the Support card does not
                end on a stray rule in production. */}
            {__DEV__ && (
              <>
                <Divider />
                <SettingsRow
                  icon={<ShieldCheck size={18} color={theme.colors.primary} />}
                  title={verifying ? 'Verifying Rounds…' : 'Verify My Rounds (debug)'}
                  subtitle="Check every round is playable after reinstall"
                  onPress={handleVerifyRounds}
                />
              </>
            )}
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
            Clippar v{APP_VERSION}
          </Text>
        </View>
      </ScrollView>
    </GradientBackground>
  );
}
