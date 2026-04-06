import { useEffect } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CheckCircle,
  XCircle,
  Wifi,
  Upload,
  Loader,
} from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Button } from '@/components/ui/Button';
import { useUpload } from '@/hooks/useUpload';

const STATUS_CONFIG = {
  idle: { label: 'Preparing upload...', icon: Upload },
  checking_wifi: { label: 'Checking connection...', icon: Wifi },
  uploading: { label: 'Uploading clips...', icon: Upload },
  submitting: { label: 'Starting processing...', icon: Upload },
  processing: { label: 'Creating your highlight reel...', icon: Loader },
  completed: { label: 'Your reel is ready!', icon: CheckCircle },
  error: { label: 'Something went wrong', icon: XCircle },
} as const;

export default function UploadScreen() {
  const insets = useSafeAreaInsets();
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const upload = useUpload(roundId ?? '');

  useEffect(() => {
    if (roundId && upload.status === 'idle') {
      upload.startUpload();
    }
  }, [roundId]);

  const { icon: Icon, label } = STATUS_CONFIG[upload.status];

  const iconColor =
    upload.status === 'completed'
      ? theme.colors.birdie
      : upload.status === 'error'
        ? theme.colors.accentRed
        : upload.status === 'uploading' || upload.status === 'submitting'
          ? theme.colors.primary
          : theme.colors.textSecondary;

  return (
    <GradientBackground>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
          paddingTop: insets.top,
        }}
      >
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: `${iconColor}20`,
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 24,
          }}
        >
          <Icon size={36} color={iconColor} />
        </View>

        <Text
          style={{
            ...theme.typography.h2,
            color: theme.colors.textPrimary,
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          {upload.status === 'completed'
            ? 'Reel Ready!'
            : upload.status === 'error'
              ? 'Upload Failed'
              : 'Processing Round'}
        </Text>

        <Text
          style={{
            ...theme.typography.body,
            color: theme.colors.textSecondary,
            marginBottom: 32,
            textAlign: 'center',
            maxWidth: 300,
          }}
        >
          {upload.status === 'error' ? (upload.error ?? label) : label}
        </Text>

        {upload.status === 'uploading' && (
          <View style={{ width: '100%', maxWidth: 300, marginBottom: 32 }}>
            <ProgressBar
              progress={upload.overallProgress}
              label={`Clip ${upload.currentClip} of ${upload.totalClips} (${upload.overallProgress}%)`}
            />
          </View>
        )}

        {upload.status === 'processing' && (
          <Text
            style={{
              color: theme.colors.textTertiary,
              fontSize: 13,
              marginBottom: 32,
              textAlign: 'center',
            }}
          >
            This usually takes 1-3 minutes. You can leave this screen.
          </Text>
        )}

        {upload.status === 'completed' && (
          <View style={{ width: '100%', maxWidth: 300, gap: 12 }}>
            <Button
              title="View Reel"
              onPress={() => router.replace(`/round/${roundId}`)}
            />
            <Button
              title="Back to Library"
              onPress={() => router.replace('/(tabs)')}
              variant="secondary"
            />
          </View>
        )}

        {upload.status === 'error' && (
          <View style={{ width: '100%', maxWidth: 300, gap: 12 }}>
            <Button title="Retry" onPress={upload.retry} />
            <Button
              title="Back"
              onPress={() => router.back()}
              variant="secondary"
            />
          </View>
        )}

        {(upload.status === 'uploading' || upload.status === 'processing') && (
          <Button
            title="Cancel"
            onPress={() => {
              upload.cancelUpload();
              router.back();
            }}
            variant="ghost"
            style={{ marginTop: 16 }}
          />
        )}
      </View>
    </GradientBackground>
  );
}
