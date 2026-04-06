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
import { useUploadContext } from '@/contexts/UploadContext';
import type { UploadState } from '@/contexts/UploadContext';

const STAGE_CONFIG: Record<UploadState['stage'], { label: string; icon: typeof Upload }> = {
  idle: { label: 'Preparing upload...', icon: Upload },
  preparing: { label: 'Checking connection...', icon: Wifi },
  uploading: { label: 'Uploading clips...', icon: Upload },
  submitting: { label: 'Starting processing...', icon: Upload },
  processing: { label: 'Creating your highlight reel...', icon: Loader },
  completed: { label: 'Your reel is ready!', icon: CheckCircle },
  error: { label: 'Something went wrong', icon: XCircle },
};

export default function UploadScreen() {
  const insets = useSafeAreaInsets();
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const { upload, startUpload, cancelUpload, retryUpload, dismissUpload } = useUploadContext();

  useEffect(() => {
    if (roundId && upload.stage === 'idle') {
      startUpload(roundId, '');
    }
  }, [roundId]);

  const stage = upload.stage;
  const { icon: Icon, label } = STAGE_CONFIG[stage];

  const iconColor =
    stage === 'completed'
      ? theme.colors.birdie
      : stage === 'error'
        ? theme.colors.accentRed
        : stage === 'uploading' || stage === 'submitting'
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
          {stage === 'completed'
            ? 'Reel Ready!'
            : stage === 'error'
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
          {stage === 'error' ? (upload.error ?? label) : (upload.stageLabel || label)}
        </Text>

        {stage === 'uploading' && (
          <View style={{ width: '100%', maxWidth: 300, marginBottom: 32 }}>
            <ProgressBar
              progress={upload.progress}
              label={`Clip ${upload.currentClip} of ${upload.totalClips} (${upload.progress}%)`}
            />
          </View>
        )}

        {stage === 'processing' && (
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

        {stage === 'completed' && (
          <View style={{ width: '100%', maxWidth: 300, gap: 12 }}>
            <Button
              title="View Reel"
              onPress={() => {
                dismissUpload();
                router.replace(`/round/${roundId}`);
              }}
            />
            <Button
              title="Back to Library"
              onPress={() => {
                dismissUpload();
                router.replace('/(tabs)');
              }}
              variant="secondary"
            />
          </View>
        )}

        {stage === 'error' && (
          <View style={{ width: '100%', maxWidth: 300, gap: 12 }}>
            <Button title="Retry" onPress={retryUpload} />
            <Button
              title="Back"
              onPress={() => {
                dismissUpload();
                router.back();
              }}
              variant="secondary"
            />
          </View>
        )}

        {(stage === 'uploading' || stage === 'processing') && (
          <Button
            title="Cancel"
            onPress={() => {
              cancelUpload();
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
