import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Switch, Pressable, Alert, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Camera, Cloud, Trash2, Info, Lock } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  getMirrorClipsToPhotos,
  setMirrorClipsToPhotos,
  getCloudBackupEnabled,
  setCloudBackupEnabled,
} from '@/lib/storage';
import { useSubscription } from '@/hooks/useSubscription';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export default function StorageSettingsScreen() {
  const router = useRouter();
  const { isSubscribed, loading: subLoading } = useSubscription();

  const [mirrorClips, setMirrorClips] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    (async () => {
      setMirrorClips(await getMirrorClipsToPhotos());
      setCloudBackup(await getCloudBackupEnabled());
    })();
  }, []);

  const onToggleMirror = useCallback(async (val: boolean) => {
    Haptics.selectionAsync();
    setMirrorClips(val);
    await setMirrorClipsToPhotos(val);
  }, []);

  const onToggleCloudBackup = useCallback(async (val: boolean) => {
    if (val && !isSubscribed) {
      Alert.alert(
        'Pro feature',
        'Cloud backup keeps your raw clips safe in the cloud so they survive an app reinstall. Available on Clippar Pro.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Upgrade', onPress: () => router.push('/profile') },
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
          subtitle="Mirror every imported & recorded clip to your iPhone's camera roll. Off by default to save space."
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
              ? 'Upload raw clips to the cloud as a safety net. Required to recover clips after reinstall on devices without Photos mirroring.'
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
          <ExplainerLine
            ok={mirrorClips}
            text={
              mirrorClips
                ? 'Raw clips — mirrored to Photos, will re-import on reinstall.'
                : 'Raw clips — not mirrored to Photos. Will be lost unless cloud backup is on.'
            }
          />
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
