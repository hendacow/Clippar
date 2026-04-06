import { useRef, useEffect, useCallback, useState } from 'react';
import { View, Text, Pressable, Alert, Platform } from 'react-native';
import { Link2, Share2, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
import { shareReel, getShareUrl } from '@/lib/sharing';

interface ShareSheetProps {
  visible: boolean;
  roundId: string;
  reelUrl: string | null;
  courseName: string;
  score?: number;
  onDismiss: () => void;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

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
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
      // Generate share link
      getShareUrl(roundId).then(setShareLink);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible, roundId]);

  const handleClose = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  const handleCopyLink = async () => {
    if (!shareLink) return;
    setCopying(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Share Link', shareLink);
    setCopying(false);
  };

  const handleShare = async () => {
    if (!reelUrl) return;
    await shareReel({ reelUrl, courseName, score });
  };

  const actions = [
    {
      icon: Link2,
      label: 'Copy Link',
      onPress: handleCopyLink,
      disabled: !shareLink,
    },
    {
      icon: Share2,
      label: 'Share Video',
      onPress: handleShare,
      disabled: !reelUrl,
    },
  ];

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={['35%']}
      enablePanDownToClose
      onClose={handleClose}
      backgroundStyle={{ backgroundColor: theme.colors.surfaceElevated }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
    >
      <BottomSheetView style={{ flex: 1, padding: 24 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <Text
            style={{
              ...theme.typography.h3,
              color: theme.colors.textPrimary,
            }}
          >
            Share Round
          </Text>
          <Pressable onPress={onDismiss} hitSlop={12}>
            <X size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {actions.map((action, i) => {
          const Icon = action.icon;
          return (
            <Pressable
              key={i}
              onPress={action.onPress}
              disabled={action.disabled}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                paddingVertical: 14,
                opacity: action.disabled ? 0.4 : 1,
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
                <Icon
                  size={18}
                  color={theme.colors.textPrimary}
                />
              </View>
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontSize: 16,
                  fontWeight: '500',
                }}
              >
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheet>
  );
}
