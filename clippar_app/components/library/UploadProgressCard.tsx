import { useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated } from 'react-native';
import { Upload, Loader, CheckCircle, XCircle, X } from 'lucide-react-native';
import { router } from 'expo-router';
import { theme } from '@/constants/theme';
import { useUploadContext } from '@/contexts/UploadContext';

function estimateTimeLeft(currentClip: number, totalClips: number, stage: string, progress: number): string | null {
  if (stage === 'uploading' && totalClips > 0 && currentClip > 0) {
    const remaining = totalClips - currentClip;
    const secondsLeft = remaining * 8;
    if (secondsLeft < 60) return `~${secondsLeft}s left`;
    return `~${Math.ceil(secondsLeft / 60)} min left`;
  }
  if (stage === 'processing') {
    // Estimate based on pipeline progress (42-100 range)
    if (progress < 50) return 'Usually 2-4 minutes';
    if (progress < 70) return 'About 1-2 minutes left';
    if (progress < 90) return 'Less than a minute left';
    return 'Almost done...';
  }
  return null;
}

export function UploadProgressCard() {
  const { upload, cancelUpload, retryUpload, dismissUpload } = useUploadContext();
  const pulseAnim = useRef(new Animated.Value(0.4)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Pulse animation for active stages
  useEffect(() => {
    if (upload.stage === 'processing' || upload.stage === 'uploading' || upload.stage === 'submitting' || upload.stage === 'preparing') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 800, useNativeDriver: false }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [upload.stage, pulseAnim]);

  // Smooth progress bar animation
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: upload.progress / 100,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [upload.progress, progressAnim]);

  if (upload.stage === 'idle') return null;

  const isActive = ['preparing', 'uploading', 'submitting', 'processing'].includes(upload.stage);
  const isError = upload.stage === 'error';
  const isComplete = upload.stage === 'completed';

  const iconColor = isError
    ? theme.colors.bogey
    : isComplete
      ? theme.colors.primary
      : theme.colors.textSecondary;

  const barColor = isError
    ? theme.colors.bogey
    : isComplete
      ? theme.colors.primary
      : theme.colors.primary;

  return (
    <View
      style={{
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: isError ? `${theme.colors.bogey}40` : theme.colors.surfaceBorder,
        padding: 14,
        overflow: 'hidden',
      }}
    >
      {/* Top row: icon + label + action */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Animated.View style={{ opacity: isActive ? pulseAnim : 1 }}>
          {isError ? (
            <XCircle size={20} color={iconColor} />
          ) : isComplete ? (
            <CheckCircle size={20} color={iconColor} />
          ) : upload.stage === 'processing' ? (
            <Loader size={20} color={iconColor} />
          ) : (
            <Upload size={20} color={iconColor} />
          )}
        </Animated.View>

        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 14,
              fontWeight: '600',
            }}
            numberOfLines={1}
          >
            {upload.stageLabel}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 }}>
            {upload.courseName && (
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 12,
                }}
                numberOfLines={1}
              >
                {upload.courseName}
              </Text>
            )}
            {upload.totalClips > 0 && isActive && (
              <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
                · {upload.currentClip}/{upload.totalClips} clips
              </Text>
            )}
          </View>
          {isActive && (() => {
            const eta = estimateTimeLeft(upload.currentClip, upload.totalClips, upload.stage, upload.progress);
            return eta ? (
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11, marginTop: 2 }}>
                {eta}
              </Text>
            ) : null;
          })()}
        </View>

        {/* Action buttons */}
        {isActive && (
          <Pressable
            onPress={cancelUpload}
            hitSlop={12}
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: theme.colors.surface,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <X size={14} color={theme.colors.textTertiary} />
          </Pressable>
        )}
        {isError && (
          <Pressable
            onPress={retryUpload}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.primary,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Retry</Text>
          </Pressable>
        )}
        {isComplete && (
          <Pressable
            onPress={() => {
              if (upload.roundId) {
                if (upload.reelUrl) {
                  router.push(`/round/${upload.roundId}`);
                } else {
                  router.push(`/round/editor?roundId=${upload.roundId}`);
                }
              }
              dismissUpload();
            }}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.primary,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
              {upload.reelUrl ? 'View' : 'Edit Reel'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Progress bar */}
      {isActive && (
        <Text style={{ color: theme.colors.textTertiary, fontSize: 11, marginTop: 8, textAlign: 'right' }}>
          {upload.progress}%
        </Text>
      )}
      <View
        style={{
          marginTop: isActive ? 2 : 10,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.colors.surface,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={{
            height: '100%',
            borderRadius: 2,
            backgroundColor: barColor,
            width: progressAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          }}
        />
      </View>

      {/* Error message */}
      {isError && upload.error && (
        <Text
          style={{
            color: theme.colors.bogey,
            fontSize: 11,
            marginTop: 6,
          }}
          numberOfLines={2}
        >
          {upload.error}
        </Text>
      )}
    </View>
  );
}
