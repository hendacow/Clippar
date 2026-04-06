import { useRef, useEffect, useCallback, useState } from 'react';
import { View, Text, Pressable, Alert, Platform, ActivityIndicator } from 'react-native';
import { Link2, Share2, X, Download, Camera, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
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

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
      setSaveState('idle');
      setShareState('idle');
      getShareUrl(roundId).then(setShareLink);
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

  const handleCopyLink = async () => {
    if (!shareLink) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Use Clipboard if available, fallback to Alert
    try {
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(shareLink);
      Alert.alert('Copied!', 'Share link copied to clipboard.');
    } catch {
      Alert.alert('Share Link', shareLink);
    }
  };

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

        {/* Copy Link */}
        <ActionRow
          icon={Link2}
          label="Copy Link"
          onPress={handleCopyLink}
          disabled={!shareLink}
        />

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
