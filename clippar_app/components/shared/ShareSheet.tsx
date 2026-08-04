import { useRef, useEffect, useCallback, useState } from 'react';
import { View, Text, Pressable, Alert, Platform, ActivityIndicator } from 'react-native';
import { Link2, Share2, X, Download, Camera, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import {
  shareReel,
  getShareUrl,
  saveToGallery,
  shareToInstagramStories,
} from '@/lib/sharing';

interface ShareSheetProps {
  visible: boolean;
  roundId: string;
  reelUrl: string | null;
  courseName: string;
  score?: number;
  onDismiss: () => void;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type ActionState = 'idle' | 'loading' | 'done';

export function ShareSheet({
  visible,
  roundId,
  reelUrl,
  courseName,
  score,
  onDismiss,
}: ShareSheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<ActionState>('idle');
  const [shareState, setShareState] = useState<ActionState>('idle');
  const [linkState, setLinkState] = useState<ActionState>('idle');

  // MERELY OPENING THIS SHEET MUST NOT TOUCH THE NETWORK.
  // This effect used to call getShareUrl(roundId) here, which runs
  // ensureReelUploaded → uploadReelToStorage: opening the sheet pushed the
  // whole stitched reel — the user's footage AND its original ambient audio —
  // to Supabase Storage and minted a permanent share_token, before the user
  // had picked any action. The reel is local-only by default (the editor
  // writes a file:// reel_url) and cloud backup is off by default, so this
  // silently overrode the user's opt-out and contradicted the copy on
  // profile/storage-settings ("Cloud backup off — clips not in the cloud").
  // Dismissing the sheet did not undo it. Minting now happens only inside
  // handleCopyLink, behind an explicit confirmation — see MEDIA-001.
  // The other three actions are deliberately local-only: Save to Camera Roll,
  // the native share sheet and Instagram Stories all read `reelUrl` off disk.
  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
      setSaveState('idle');
      setShareState('idle');
      setLinkState('idle');
      // Drop any link minted for a previous round so the confirmation is
      // re-shown per round rather than silently reusing a stale token.
      setShareLink(null);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible, roundId]);

  const handleClose = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  const handleSaveToGallery = async () => {
    if (!reelUrl) return;
    setSaveState('loading');
    try {
      const saved = await saveToGallery(reelUrl, roundId);
      if (saved) {
        setSaveState('done');
        setTimeout(() => setSaveState('idle'), 2500);
      } else {
        Alert.alert('Permission Required', 'Allow Clippar to save videos in Settings.');
        setSaveState('idle');
      }
    } catch {
      Alert.alert('Error', 'Failed to save video. Try again.');
      setSaveState('idle');
    }
  };

  const handleShare = async () => {
    if (!reelUrl) return;
    setShareState('loading');
    try {
      await shareReel({ reelUrl, roundId, courseName, score });
    } catch {}
    setShareState('idle');
  };

  const copyToClipboard = useCallback(async (url: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Use Clipboard if available, fallback to Alert
    try {
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(url);
      Alert.alert('Copied!', 'Share link copied to clipboard.');
    } catch {
      Alert.alert('Share Link', url);
    }
  }, []);

  // getShareUrl is the ONLY path in this sheet that leaves the device: it
  // uploads the reel and mints a share_token that never expires. It runs here
  // and nowhere else, and only after the user has said yes to a dialog that
  // says so in plain words — a tap on "Copy Link" alone is not consent to
  // publish a golfer's footage, because the user may be reaching for it to
  // check what it does.
  const mintAndCopyLink = useCallback(async () => {
    setLinkState('loading');
    try {
      const url = await getShareUrl(roundId);
      if (!url) {
        Alert.alert(
          'Could not create link',
          'Your reel could not be uploaded. Check your connection and try again.'
        );
        return;
      }
      setShareLink(url);
      await copyToClipboard(url);
    } catch {
      Alert.alert(
        'Could not create link',
        'Your reel could not be uploaded. Check your connection and try again.'
      );
    } finally {
      setLinkState('idle');
    }
  }, [roundId, copyToClipboard]);

  const handleCopyLink = useCallback(() => {
    if (linkState === 'loading') return;
    // Already uploaded earlier in this sheet session — the user consented then,
    // and re-copying the same link uploads nothing new.
    if (shareLink) {
      void copyToClipboard(shareLink);
      return;
    }
    Alert.alert(
      'Create a share link?',
      'This uploads this reel to Clippar so anyone with the link can watch it. ' +
        'Save to Camera Roll and Share Video keep the video on your device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Upload & copy link',
          onPress: () => {
            void mintAndCopyLink();
          },
        },
      ]
    );
  }, [linkState, shareLink, copyToClipboard, mintAndCopyLink]);

  const handleInstagramStories = async () => {
    if (!reelUrl) return;
    await shareToInstagramStories(reelUrl, roundId);
  };

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={['50%']}
      enablePanDownToClose
      onClose={handleClose}
      backgroundStyle={{ backgroundColor: theme.colors.surfaceElevated }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ flex: 1, padding: 24 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary }}>
            Share Round
          </Text>
          <Pressable onPress={onDismiss} hitSlop={12}>
            <X size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {/* Save to Camera Roll */}
        <ActionRow
          icon={saveState === 'done' ? Check : Download}
          label={
            saveState === 'loading'
              ? 'Saving...'
              : saveState === 'done'
                ? 'Saved to Camera Roll'
                : 'Save to Camera Roll'
          }
          onPress={handleSaveToGallery}
          disabled={!reelUrl || saveState === 'loading'}
          loading={saveState === 'loading'}
          tint={saveState === 'done' ? theme.colors.primary : undefined}
        />

        {/* Share Video */}
        <ActionRow
          icon={Share2}
          label={shareState === 'loading' ? 'Preparing...' : 'Share Video'}
          onPress={handleShare}
          disabled={!reelUrl || shareState === 'loading'}
          loading={shareState === 'loading'}
        />

        {/* Copy Link — the only action here that uploads anything, and the only
            one gated. With config.sharing.reelLinksEnabled off, this sheet
            never leaves the device. See the flag for why. */}
        {config.sharing.reelLinksEnabled ? (
          <ActionRow
            icon={Link2}
            label={
              linkState === 'loading'
                ? 'Uploading reel...'
                : shareLink
                  ? 'Copy Link'
                  : 'Create Share Link'
            }
            onPress={handleCopyLink}
            disabled={!reelUrl || linkState === 'loading'}
            loading={linkState === 'loading'}
          />
        ) : null}

        {/* Instagram Stories */}
        <ActionRow
          icon={Camera}
          label="Instagram Stories"
          onPress={handleInstagramStories}
          disabled={!reelUrl}
        />
      </BottomSheetView>
    </BottomSheet>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onPress,
  disabled,
  loading,
  tint,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 14,
        opacity: disabled && !loading ? 0.4 : 1,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: theme.colors.surface,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {loading ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <Icon size={18} color={tint ?? theme.colors.textPrimary} />
        )}
      </View>
      <Text
        style={{
          color: tint ?? theme.colors.textPrimary,
          fontSize: 16,
          fontWeight: '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
