import { useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Music, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { PreviewPlayer } from '@/components/editor/PreviewPlayer';
import { ClipTimeline } from '@/components/editor/ClipTimeline';
import { MusicPicker } from '@/components/editor/MusicPicker';
import { getRound, updateRound } from '@/lib/api';

export default function EditorScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const insets = useSafeAreaInsets();
  const [round, setRound] = useState<any>(null);
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedTrackName, setSelectedTrackName] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (roundId) {
      getRound(roundId)
        .then(setRound)
        .catch(() => {});
    }
  }, [roundId]);

  const shots = round?.shots ?? [];
  const clips = shots.map((s: any, i: number) => ({
    id: s.id ?? String(i),
    holeNumber: s.hole_number,
    shotNumber: s.shot_number,
  }));

  const handlePublish = async () => {
    if (!roundId) return;
    setPublishing(true);
    try {
      await updateRound(roundId, {
        is_published: true,
        ...(selectedTrackId ? { music_track_id: selectedTrackId } : {}),
      } as any);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 17,
            }}
          >
            Edit Reel
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Preview player */}
        <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
          <PreviewPlayer source={round?.reel_url ?? null} />
        </View>

        {/* Clip timeline */}
        <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 13,
              fontWeight: '600',
              marginBottom: 8,
            }}
          >
            CLIPS
          </Text>
          <ClipTimeline clips={clips} />
        </View>

        {/* Music selector */}
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowMusicPicker(true);
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            marginHorizontal: 16,
            padding: 14,
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
          }}
        >
          <Music size={20} color={theme.colors.primary} />
          <View style={{ flex: 1 }}>
            <Text
              style={{ color: theme.colors.textPrimary, fontWeight: '600' }}
            >
              Background Music
            </Text>
            <Text
              style={{ color: theme.colors.textSecondary, fontSize: 13 }}
            >
              {selectedTrackName ?? 'No music selected'}
            </Text>
          </View>
        </Pressable>

        {/* Publish */}
        <View style={{ flex: 1 }} />
        <View style={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
          <Button
            title={publishing ? 'Publishing...' : 'Publish to Library'}
            onPress={handlePublish}
            icon={<Check size={18} color="#FFFFFF" />}
            disabled={publishing}
          />
        </View>
      </View>

      <MusicPicker
        visible={showMusicPicker}
        selectedTrackId={selectedTrackId}
        onSelect={(track) => {
          setSelectedTrackId(track?.id ?? null);
          setSelectedTrackName(track?.title ?? null);
          setShowMusicPicker(false);
        }}
        onDismiss={() => setShowMusicPicker(false)}
      />
    </GradientBackground>
  );
}
