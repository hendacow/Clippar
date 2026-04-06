import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { Music, Check, X } from 'lucide-react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
import { getMusicTracks } from '@/lib/api';

interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  duration_seconds: number;
  preview_url: string | null;
}

interface MusicPickerProps {
  visible: boolean;
  selectedTrackId: string | null;
  onSelect: (track: MusicTrack | null) => void;
  onDismiss: () => void;
}

export function MusicPicker({ visible, selectedTrackId, onSelect, onDismiss }: MusicPickerProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);

  useEffect(() => {
    getMusicTracks()
      .then((data) => setTracks(data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

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
      <BottomSheetView style={{ flex: 1, paddingHorizontal: 16 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary }}>
            Background Music
          </Text>
          <Pressable onPress={onDismiss} hitSlop={12}>
            <X size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {/* No music option */}
        <Pressable
          onPress={() => onSelect(null)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            padding: 12,
            borderRadius: theme.radius.md,
            backgroundColor: !selectedTrackId
              ? theme.colors.primaryMuted
              : 'transparent',
            marginBottom: 8,
          }}
        >
          <X size={18} color={theme.colors.textSecondary} />
          <Text style={{ color: theme.colors.textPrimary, marginLeft: 12, flex: 1 }}>
            No Music
          </Text>
          {!selectedTrackId && <Check size={18} color={theme.colors.primary} />}
        </Pressable>

        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const isSelected = selectedTrackId === item.id;
            return (
              <Pressable
                onPress={() => onSelect(item)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 12,
                  borderRadius: theme.radius.md,
                  backgroundColor: isSelected ? theme.colors.primaryMuted : 'transparent',
                  marginBottom: 4,
                }}
              >
                <Music size={18} color={isSelected ? theme.colors.primary : theme.colors.textSecondary} />
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    {item.artist} &middot; {Math.floor(item.duration_seconds / 60)}:{String(Math.floor(item.duration_seconds % 60)).padStart(2, '0')}
                  </Text>
                </View>
                {isSelected && <Check size={18} color={theme.colors.primary} />}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: theme.colors.textTertiary, textAlign: 'center', paddingVertical: 24 }}>
              No music tracks available
            </Text>
          }
        />
      </BottomSheetView>
    </BottomSheet>
  );
}
