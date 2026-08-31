import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Switch, Pressable, Alert, Platform, Linking } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Camera, Cloud, Trash2, Info, Lock } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  getMirrorClipsToPhotos,
  setMirrorClipsToPhotos,
  getCloudBackupEnabled,
  setCloudBackupEnabled,
  getUploadOverCellular,
  setUploadOverCellular,
  getClipMirrorStats,
} from '@/lib/storage';
import {
  getPhotosMirrorPermission,
  requestPhotosMirrorPermission,
  type PhotosMirrorPermission,
} from '@/lib/photosMirror';
import { describeRawClipStatus } from '@/lib/photosMirrorPolicy';
import { useSubscription } from '@/hooks/useSubscription';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export default function StorageSettingsScreen() {
  const router = useRouter();
  const { isSubscribed, loading: subLoading } = useSubscription();

  const [mirrorClips, setMirrorClips] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(false);
  const [cellularUpload, setCellularUpload] = useState(false);
  useEffect(() => {
    getUploadOverCellular().then(setCellularUpload).catch(() => {});
  }, []);
  const [clearing, setClearing] = useState(false);
  // What is TRUE about this device, as opposed to what the switches are set
  // to. The recovery card below is read by people deciding whether it is safe
  // to wipe their phone, so it reports these, not the toggle positions.
  const [photosPermission, setPhotosPermission] =
    useState<PhotosMirrorPermission>('unavailable');
  const [mirrorStats, setMirrorStats] = useState<{ total: number; mirrored: number } | null>(null);

  const refreshEvidence = useCallback(async () => {
    // Non-prompting: reading permission must never raise a dialog just
    // because someone opened a settings screen.
    setPhotosPermission(await getPhotosMirrorPermission());
    try {
      setMirrorStats(await getClipMirrorStats());
    } catch {
      // Leave null — the card falls back to describing the setting rather
      // than inventing a count.
    }
  }, []);

  useEffect(() => {
    (async () => {
      setMirrorClips(await getMirrorClipsToPhotos());
      setCloudBackup(await getCloudBackupEnabled());
      await refreshEvidence();
    })();
  }, [refreshEvidence]);

  // Turning this on is the moment the user commits to Photos mirroring, so it
  // is the moment to ask for Photos access — and the ONLY one. The capture
  // paths deliberately never prompt (lib/photosMirror, rule 2: a clicker press
  // must not raise a permission dialog over a live camera). That means a
  // switch left on without permission is a switch that silently does nothing,
  // which is the failure this whole change exists to remove — so if the user
  // refuses, the setting does not go on.
  const onToggleMirror = useCallback(async (val: boolean) => {
    if (val && isNative) {
      const granted = await requestPhotosMirrorPermission();
      if (!granted) {
        setPhotosPermission(await getPhotosMirrorPermission());
        Alert.alert(
          'Photos access needed',
          'Clippar can only copy your raw clips to the camera roll with access to Photos. Turn it on in Settings, then switch this back on.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
          ]
        );
        return;
      }
    }
    Haptics.selectionAsync();
    setMirrorClips(val);
    await setMirrorClipsToPhotos(val);
    await refreshEvidence();
  }, [refreshEvidence]);

  // Shown when the setting is on but Photos access is not — the exact state
  // the old green tick hid.
  const onFixPhotosAccess = useCallback(async () => {
    if (photosPermission === 'undetermined') {
      const granted = await requestPhotosMirrorPermission();
      if (granted) {
        await refreshEvidence();
        return;
      }
    }
    void Linking.openSettings();
    await refreshEvidence();
  }, [photosPermission, refreshEvidence]);

  const onToggleCloudBackup = useCallback(async (val: boolean) => {
    if (val && !isSubscribed) {
      Alert.alert(
        'Pro feature',
        'Photos keeps your shots if you delete the app. Cloud backup keeps them if you lose the phone. They protect against different things — Cloud backup is the Pro one.',
        [
          { text: 'Not now', style: 'cancel' },
          // Was router.push('/profile') — the tab this alert is already on top
          // of, so Upgrade dismissed the dialog and appeared to do nothing.
          // A button labelled Upgrade that never reaches a purchase reads as a
          // broken control to a reviewer and as a dead end to a customer.
          { text: 'Upgrade', onPress: () => router.push('/paywall') },
        ]
      );
      return;
    }
    Haptics.selectionAsync();
    setCloudBackup(val);
    await setCloudBackupEnabled(val);
  }, [isSubscribed, router]);

  const onClearCache = useCallback(async () => {
    if (!isNative) return;
    Alert.alert(
      'Clear cache?',
      'Removes temporary download/compression files. Your rounds and clips are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            try {
              const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
              const cacheDir = FS.cacheDirectory;
              if (cacheDir) {
                const recovered = `${cacheDir}recovered-clips/`;
                try {
                  await FS.deleteAsync(recovered, { idempotent: true });
                } catch {}
              }
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Done', 'Cache cleared.');
            } catch (err) {
              Alert.alert('Error', 'Could not clear cache.');
            } finally {
              setClearing(false);
            }
          },
        },
      ]
    );
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: 'Storage & Backup' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        {/* Mirror raw clips to Photos */}
        <SettingRow
          icon={<Camera size={18} color={theme.colors.primary} />}
          tint={theme.colors.primary}
          title="Save raw clips to Photos"
          subtitle="Every shot is also saved to a Clippar album in your Photos. If you ever delete the app, your shots are still there and your rounds can restore from them. On by default. This does NOT protect against losing your phone — that's Cloud backup."
        >
          <Switch
            value={mirrorClips}
            onValueChange={onToggleMirror}
            trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
            thumbColor="#fff"
          />
        </SettingRow>

        {/* Cloud backup */}
        <SettingRow
          icon={
            !isSubscribed ? (
              <Lock size={18} color={theme.colors.textSecondary} />
            ) : (
              <Cloud size={18} color="#2196F3" />
            )
          }
          tint={!isSubscribed ? theme.colors.textSecondary : '#2196F3'}
          title={isSubscribed ? 'Cloud backup' : 'Cloud backup (Pro)'}
          subtitle={
            isSubscribed
              ? 'Your clips upload in the background and survive a LOST or replaced phone — the one thing your camera roll cannot do. On by default with Pro; turn it off any time.'
              : 'Available on Clippar Pro. Tap the switch to learn more.'
          }
        >
          <Switch
            value={cloudBackup && isSubscribed}
            onValueChange={onToggleCloudBackup}
            disabled={subLoading}
            trackColor={{ false: theme.colors.surfaceBorder, true: '#2196F3' }}
            thumbColor="#fff"
          />

        {/* Mobile-data uploads — wifi-only by default. What uploads is video;
            a metered plan is the user's money. Explicit opt-in only. */}
        <SettingRow
          icon={<Cloud size={18} color={theme.colors.textSecondary} />}
          tint={theme.colors.textSecondary}
          title="Upload over mobile data"
          subtitle="Off by default — backups wait for wi-fi. Turn on to upload anywhere; golf video can use a lot of data."
        >
          <Switch
            value={cellularUpload}
            onValueChange={async (v) => {
              setCellularUpload(v);
              await setUploadOverCellular(v);
            }}
          />
        </SettingRow>
        </SettingRow>

        {/* Recovery explainer */}
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            padding: 16,
            marginTop: 8,
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Info size={16} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 14 }}>
              What happens if I uninstall Clippar?
            </Text>
          </View>
          <ExplainerLine
            ok
            text="Highlight reels — always saved to your camera roll, survive uninstall."
          />
          {(() => {
            const status = describeRawClipStatus({
              mirrorOn: mirrorClips,
              permission: isNative ? photosPermission : 'unavailable',
              stats: mirrorStats,
            });
            return <ExplainerLine ok={status.ok} text={status.text} />;
          })()}
          {mirrorClips && isNative && photosPermission !== 'granted' && (
            <>
              <ExplainerLine
                ok={false}
                text={
                  photosPermission === 'undetermined'
                    ? "Photos access hasn't been granted, so nothing is being copied."
                    : 'Photos access is off, so nothing is being copied.'
                }
              />
              <Pressable onPress={onFixPhotosAccess} hitSlop={8}>
                <Text
                  style={{
                    color: theme.colors.primary,
                    fontSize: 13,
                    fontWeight: '600',
                    marginTop: 4,
                    marginLeft: 20,
                  }}
                >
                  {photosPermission === 'undetermined' ? 'Allow Photos access' : 'Open Settings'}
                </Text>
              </Pressable>
            </>
          )}
          <ExplainerLine
            ok={cloudBackup && isSubscribed}
            text={
              cloudBackup && isSubscribed
                ? 'Cloud backup on — clips re-download from the cloud on reinstall.'
                : 'Cloud backup off — clips not in the cloud.'
            }
          />
          <ExplainerLine
            ok
            text="Round scores & metadata — always synced, restored on reinstall."
          />
        </View>

        {/* Clear cache */}
        <Pressable
          onPress={onClearCache}
          disabled={clearing}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 16,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            backgroundColor: theme.colors.surfaceElevated,
            opacity: pressed || clearing ? 0.6 : 1,
          })}
        >
          <Trash2 size={18} color={theme.colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
              Clear cache
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
              Removes temporary recovery & compression files
            </Text>
          </View>
        </Pressable>
      </ScrollView>
    </>
  );
}

function SettingRow({
  icon,
  tint,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.surfaceBorder,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, marginRight: 12 }}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              backgroundColor: tint + '20',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            {icon}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
              {title}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
              {subtitle}
            </Text>
          </View>
        </View>
        {children}
      </View>
    </View>
  );
}

function ExplainerLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 4 }}>
      <Text style={{ color: ok ? '#4CAF50' : theme.colors.textTertiary, fontSize: 13, lineHeight: 18 }}>
        {ok ? '✓' : '✕'}
      </Text>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}
