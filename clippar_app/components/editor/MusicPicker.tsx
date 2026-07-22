import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, FlatList } from 'react-native';
import { Music, Check, X } from 'lucide-react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { theme } from '@/constants/theme';
import { getMusicTracks } from '@/lib/api';
import { MUSIC_LIBRARY } from '@/lib/musicLibrary';

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  duration_seconds: number;
  file_url: string | null;
  preview_url: string | null;
}

/**
 * Bundled royalty-free tracks that are always available (shipped with the
 * app). Sourced from lib/musicLibrary.ts — the single source of truth —
 * mapped into this picker's MusicTrack shape. Includes the legacy Clippar
 * tracks so reels that already reference them keep resolving.
 */
const BUNDLED_TRACKS: MusicTrack[] = MUSIC_LIBRARY.map((t) => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  duration_seconds: t.durationSeconds,
  file_url: null, // resolved from app bundle at export time
  preview_url: null,
}));

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
      .then((data) => {
        // Map server rows (which use `name`) to our MusicTrack interface (which uses `title`)
        const serverTracks: MusicTrack[] = (data ?? []).map((row: any) => ({
          id: row.id,
          title: row.name ?? row.title ?? 'Untitled',
          artist: row.artist ?? 'Unknown',
          duration_seconds: row.duration_seconds ?? 0,
          file_url: row.file_url ?? null,
          preview_url: row.preview_url ?? null,
        }));
        const serverIds = new Set(serverTracks.map((t) => t.id));
        const bundled = BUNDLED_TRACKS.filter((t) => !serverIds.has(t.id));
        setTracks([...bundled, ...serverTracks]);
      })
      .catch(() => {
        // Offline or no server — show bundled tracks
        setTracks(BUNDLED_TRACKS);
      });
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
