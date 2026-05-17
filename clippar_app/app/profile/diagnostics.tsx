/**
 * Diagnostics screen — the "is my app healthy?" view.
 *
 * Per the comprehensive stabilization plan (WS5), this screen gives
 * real-time signal on every fix shipped by WS1-WS4 so the user can
 * verify each bug is actually resolved end-to-end, without having to
 * reach for Metro logs.
 *
 * Sections:
 *   1. Data integrity — local rounds vs Supabase rounds, orphan list
 *   2. Upload queue  — depth, error clips, drain button
 *   3. Auth state    — user + token + SecureStore health
 *   4. Onboarding    — flags + replay buttons
 *   5. Course API    — live 401/200 probe
 *   6. Video reach   — verifyAllRoundsReachable summary
 */

import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, RefreshCw, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { processUploadQueue } from '@/lib/uploadQueue';
import { verifyAllRoundsReachable } from '@/lib/verifyRound';
import { searchGolfCoursesLive } from '@/lib/golfCourseApi';
import { getQueuedRoundUploads, getDatabase } from '@/lib/storage';
import { useOnboarding } from '@/contexts/OnboardingContext';
import * as Sentry from '@sentry/react-native';
import * as Updates from 'expo-updates';

// Small status badge
function Status({ ok, warn, text }: { ok?: boolean; warn?: boolean; text: string }) {
  const color = ok ? theme.colors.birdie : warn ? theme.colors.bogey : theme.colors.doubleBogey;
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Icon size={14} color={color} />
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

function Row({ label, value, status }: { label: string; value?: string; status?: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.surfaceBorder,
        gap: 8,
      }}
    >
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, flex: 1 }}>{label}</Text>
      {status ?? <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '500' }}>{value}</Text>}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ marginHorizontal: 16, marginBottom: 12, padding: 14 }}>
      <Text
        style={{
          color: theme.colors.textPrimary,
          fontSize: 15,
          fontWeight: '700',
          marginBottom: 8,
        }}
      >
        {title}
      </Text>
      {children}
    </Card>
  );
}

export default function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const { flags, replayOnboarding } = useOnboarding();

  const [loading, setLoading] = useState(false);

  // Data integrity
  const [supabaseRoundsCount, setSupabaseRoundsCount] = useState<number | null>(null);
  const [localRoundsCount, setLocalRoundsCount] = useState<number | null>(null);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);

  // Upload queue
  const [queueDepth, setQueueDepth] = useState<number | null>(null);
  const [queueErrors, setQueueErrors] = useState<number>(0);

  // Auth
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authOk, setAuthOk] = useState<boolean>(false);

  // Course API
  const [courseApiStatus, setCourseApiStatus] = useState<'unknown' | 'ok' | 'unauthorized' | 'error'>('unknown');

  // Reachability
  const [reachSummary, setReachSummary] = useState<{
    pass: number;
    fail: number;
    warn: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Data integrity — count local rounds via SQLite, remote via Supabase.
      const [localRes, remoteRes] = await Promise.allSettled([
        (async () => {
          const db = await getDatabase();
          const rows = await db.getAllAsync<{ id: string }>(
            'SELECT id FROM local_rounds'
          );
          return rows;
        })(),
        supabase.from('rounds').select('id', { count: 'exact', head: false }),
      ]);

      if (localRes.status === 'fulfilled') {
        const rows = localRes.value ?? [];
        setLocalRoundsCount(rows.length);
        const orphans = rows
          .filter((r: { id: string }) => r.id.startsWith('local_'))
          .map((r: { id: string }) => r.id);
        setOrphanIds(orphans);
      }

      if (remoteRes.status === 'fulfilled') {
        setSupabaseRoundsCount(remoteRes.value.count ?? (remoteRes.value.data?.length ?? 0));
      }

      // Upload queue
      try {
        const queued = await getQueuedRoundUploads();
        setQueueDepth(queued.length);
        setQueueErrors(queued.filter((q) => q.status === 'error').length);
      } catch {
        setQueueDepth(null);
      }

      // Auth
      try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
          setAuthOk(false);
          setUserEmail(null);
        } else {
          setAuthOk(true);
          setUserEmail(user.email ?? user.id);
        }
      } catch {
        setAuthOk(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pingCourseApi = async () => {
    setCourseApiStatus('unknown');
    try {
      const results = await searchGolfCoursesLive('Pebble');
      setCourseApiStatus(results.length >= 0 ? 'ok' : 'error');
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '');
      if (msg.includes('401') || msg.toLowerCase().includes('unauthor')) {
        setCourseApiStatus('unauthorized');
      } else {
        setCourseApiStatus('error');
      }
    }
  };

  const runReachability = async () => {
    setReachSummary(null);
    try {
      const reports = await verifyAllRoundsReachable();
      const pass = reports.filter((r) => r.ok).length;
      // "fail" = hard failures (round gone / no clip URLs to sign)
      const fail = reports.filter((r) =>
        r.issues.some(
          (i) =>
            i === 'round-missing' ||
            i === 'clip-url-failed-to-sign' ||
            i === 'shots-missing-clip-url'
        )
      ).length;
      const warn = reports.length - pass - fail;
      setReachSummary({ pass, fail, warn });
    } catch (err) {
      Alert.alert('Reachability check failed', String(err));
    }
  };

  const drainQueue = async () => {
    await processUploadQueue();
    void refresh();
  };

  return (
    <GradientBackground>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            gap: 12,
          }}
        >
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 18,
              flex: 1,
            }}
          >
            Diagnostics
          </Text>
          <Pressable onPress={refresh} hitSlop={12} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <RefreshCw size={20} color={theme.colors.textPrimary} />
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingVertical: 12, paddingBottom: 48 }}>
          {/* 1. DATA INTEGRITY */}
          <Section title="Data integrity">
            <Row
              label="Rounds in SQLite"
              value={localRoundsCount == null ? '…' : String(localRoundsCount)}
            />
            <Row
              label="Rounds in Supabase"
              value={supabaseRoundsCount == null ? '…' : String(supabaseRoundsCount)}
            />
            <Row
              label="Orphaned local_* IDs"
              status={
                orphanIds.length === 0 ? (
                  <Status ok text="0 (healthy)" />
                ) : (
                  <Status text={`${orphanIds.length} (will FK-violate on upload)`} />
                )
              }
            />
            {orphanIds.length > 0 && (
              <View style={{ marginTop: 6, padding: 8, backgroundColor: theme.colors.surface, borderRadius: 6 }}>
                {orphanIds.slice(0, 5).map((id) => (
                  <Text key={id} style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
                    • {id}
                  </Text>
                ))}
                {orphanIds.length > 5 && (
                  <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
                    …and {orphanIds.length - 5} more
                  </Text>
                )}
              </View>
            )}
          </Section>

          {/* 2. UPLOAD QUEUE */}
          <Section title="Upload queue">
            <Row
              label="Pending rounds"
              value={queueDepth == null ? '…' : String(queueDepth)}
            />
            <Row
              label="Rounds with errors"
              status={
                queueErrors === 0 ? <Status ok text="0" /> : <Status warn text={String(queueErrors)} />
              }
            />
            <View style={{ marginTop: 10 }}>
              <Button title="Drain queue now" onPress={drainQueue} variant="secondary" />
            </View>
          </Section>

          {/* 3. AUTH */}
          <Section title="Auth state">
            <Row
              label="Signed in"
              status={authOk ? <Status ok text="yes" /> : <Status text="no" />}
            />
            <Row label="User" value={userEmail ?? '—'} />
          </Section>

          {/* 4. ONBOARDING */}
          <Section title="Onboarding">
            <Row
              label="Intro done"
              status={flags.introDone ? <Status ok text="yes" /> : <Status warn text="no" />}
            />
            <Row
              label="Tour done"
              status={flags.tourDone ? <Status ok text="yes" /> : <Status warn text="no" />}
            />
            <View style={{ marginTop: 10 }}>
              <Button
                title="Replay intro + tour"
                onPress={() => {
                  router.replace('/(tabs)');
                  requestAnimationFrame(() => void replayOnboarding());
                }}
                variant="secondary"
              />
            </View>
          </Section>

          {/* 5. COURSE API */}
          <Section title="Course API">
            <Row
              label="GolfCourseAPI"
              status={
                courseApiStatus === 'ok' ? (
                  <Status ok text="200 OK" />
                ) : courseApiStatus === 'unauthorized' ? (
                  <Status text="401 — check EXPO_PUBLIC_GOLF_COURSE_API_KEY" />
                ) : courseApiStatus === 'error' ? (
                  <Status warn text="error" />
                ) : (
                  <Status warn text="not tested" />
                )
              }
            />
            <View style={{ marginTop: 10 }}>
              <Button title="Ping GolfCourseAPI" onPress={pingCourseApi} variant="secondary" />
            </View>
          </Section>

          {/* 6. VIDEO REACHABILITY */}
          <Section title="Video reachability">
            <Row
              label="Last check"
              status={
                reachSummary ? (
                  reachSummary.fail === 0 && reachSummary.warn === 0 ? (
                    <Status ok text={`${reachSummary.pass} pass`} />
                  ) : (
                    <Status
                      warn
                      text={`${reachSummary.pass} pass · ${reachSummary.warn} warn · ${reachSummary.fail} fail`}
                    />
                  )
                ) : (
                  <Status warn text="not run" />
                )
              }
            />
            <View style={{ marginTop: 10 }}>
              <Button title="Verify all rounds" onPress={runReachability} variant="secondary" />
            </View>
          </Section>

          {/* OTA update status — shows which JS bundle the app is running.
              `Updates.isEmbeddedLaunch === true` means the app is on the
              bundle that shipped with the build (no OTA applied yet).
              `updateId` is the unique ID of the running update (null if
              embedded). Useful for debugging "is my OTA actually applying?"

              This panel is intentionally verbose — when OTAs aren't applying
              despite the server having a newer manifest, we need every piece
              of state expo-updates exposes to pinpoint the cause. */}
          <View style={{ marginHorizontal: 16, marginBottom: 16, gap: 8 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>
              OTA update status
            </Text>
            <Card style={{ padding: 14, gap: 6 }}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Source: </Text>
                {Updates.isEmbeddedLaunch ? '📦 Embedded (build-time bundle)' : '☁️ OTA update'}
              </Text>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Enabled: </Text>
                {String(Updates.isEnabled)}
              </Text>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Update ID: </Text>
                {Updates.updateId ?? '(embedded — no OTA)'}
              </Text>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Created: </Text>
                {Updates.createdAt ? Updates.createdAt.toISOString() : '(embedded)'}
              </Text>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Channel: </Text>
                {Updates.channel || '(none)'}
              </Text>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.textTertiary }}>Runtime: </Text>
                {Updates.runtimeVersion || '(unknown)'}
              </Text>
            </Card>
            <Button
              title="Check for update now"
              variant="secondary"
              onPress={async () => {
                try {
                  const res = await Updates.checkForUpdateAsync();
                  // Capture full response for offline diagnosis. The server's
                  // raw response is in `res.manifest`; we surface its createdAt
                  // and id so we can compare against the running update.
                  const summary = [
                    `isAvailable: ${res.isAvailable}`,
                    `reason: ${(res as any).reason ?? '(n/a)'}`,
                    `manifest.id: ${res.manifest?.id ?? '(none)'}`,
                    `manifest.createdAt: ${(res.manifest as any)?.createdAt ?? '(none)'}`,
                    `running.id: ${Updates.updateId ?? '(embedded)'}`,
                    `running.createdAt: ${Updates.createdAt?.toISOString() ?? '(embedded)'}`,
                    `running.isEmbeddedLaunch: ${Updates.isEmbeddedLaunch}`,
                    `Updates.isEnabled: ${Updates.isEnabled}`,
                    `Updates.channel: ${Updates.channel}`,
                    `Updates.runtimeVersion: ${Updates.runtimeVersion}`,
                  ].join('\n');

                  // Always log to Sentry as a breadcrumb-rich event so we can
                  // inspect from a laptop after the fact.
                  Sentry.captureMessage('OTA check result', {
                    level: 'info',
                    extra: {
                      isAvailable: res.isAvailable,
                      manifest: res.manifest ?? null,
                      reason: (res as any).reason ?? null,
                      running: {
                        updateId: Updates.updateId,
                        createdAt: Updates.createdAt?.toISOString() ?? null,
                        isEmbeddedLaunch: Updates.isEmbeddedLaunch,
                        channel: Updates.channel,
                        runtimeVersion: Updates.runtimeVersion,
                        isEnabled: Updates.isEnabled,
                      },
                    },
                  });

                  if (res.isAvailable) {
                    Alert.alert(
                      'Update available',
                      `${summary}\n\nDownload + apply now?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Apply',
                          onPress: async () => {
                            try {
                              await Updates.fetchUpdateAsync();
                              await Updates.reloadAsync();
                            } catch (e) {
                              Alert.alert('Fetch/apply failed', String(e));
                              Sentry.captureException(e, { tags: { phase: 'fetch-or-reload' } });
                            }
                          },
                        },
                      ],
                    );
                  } else {
                    Alert.alert('No update available', summary);
                  }
                } catch (e) {
                  Alert.alert('Check failed', `${e}\n\nLogged to Sentry.`);
                  Sentry.captureException(e, { tags: { phase: 'check-for-update' } });
                }
              }}
            />
            <Button
              title="Force fetch + reload (bypass check)"
              variant="secondary"
              onPress={async () => {
                Alert.alert(
                  'Force fetch?',
                  'Skips checkForUpdateAsync and goes straight to fetchUpdateAsync. If a newer OTA exists on the channel, this will download and apply it.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Fetch + reload',
                      onPress: async () => {
                        try {
                          const fetchRes = await Updates.fetchUpdateAsync();
                          Sentry.captureMessage('OTA force fetch result', {
                            level: 'info',
                            extra: {
                              isNew: fetchRes.isNew,
                              manifest: fetchRes.manifest ?? null,
                            },
                          });
                          if (fetchRes.isNew) {
                            await Updates.reloadAsync();
                          } else {
                            Alert.alert(
                              'No new bundle fetched',
                              `fetchUpdateAsync returned isNew=false.\nmanifest.id: ${(fetchRes.manifest as any)?.id ?? '(none)'}`,
                            );
                          }
                        } catch (e) {
                          Alert.alert('Force fetch failed', String(e));
                          Sentry.captureException(e, { tags: { phase: 'force-fetch' } });
                        }
                      },
                    },
                  ],
                );
              }}
            />
            <Button
              title="Dump full state to Sentry"
              variant="secondary"
              onPress={() => {
                Sentry.captureMessage('OTA diagnostic state dump', {
                  level: 'info',
                  extra: {
                    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
                    isEnabled: Updates.isEnabled,
                    updateId: Updates.updateId,
                    createdAt: Updates.createdAt?.toISOString() ?? null,
                    channel: Updates.channel,
                    runtimeVersion: Updates.runtimeVersion,
                    manifest: (Updates as any).manifest ?? null,
                    checkAutomatically: (Updates as any).checkAutomatically ?? null,
                    launchDuration: (Updates as any).launchDuration ?? null,
                  },
                });
                Alert.alert('Dumped', 'Full OTA state sent to Sentry. Check sentry.io/issues — should appear within ~10s.');
              }}
            />
          </View>

          {/* Sentry test buttons. Used once to verify the error-reporting
              pipeline is wired up. Safe to leave here — these only fire on
              explicit tap. Remove if you don't want them visible. */}
          <View style={{ marginHorizontal: 16, marginBottom: 24, gap: 8 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>
              Sentry test
            </Text>
            <Button
              title="Send test event to Sentry"
              variant="secondary"
              onPress={() => {
                Sentry.captureMessage('Sentry test message from Clippar diagnostics', 'info');
                Alert.alert('Sent', 'Check sentry.io/issues — should appear within ~10s.');
              }}
            />
            <Button
              title="Throw test exception"
              variant="secondary"
              onPress={() => {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const _ = (null as unknown as { x: number }).x; // typed null deref
                } catch (e) {
                  Sentry.captureException(e);
                  Alert.alert('Captured', 'Exception sent to Sentry. Check sentry.io/issues.');
                }
              }}
            />
          </View>
        </ScrollView>
      </View>
    </GradientBackground>
  );
}
