import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  PanResponder,
  Dimensions,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, RotateCcw } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import type { EditorClip } from '@/types/editor';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TIMELINE_PADDING = 24;
const TIMELINE_WIDTH = SCREEN_WIDTH - TIMELINE_PADDING * 2;
const HANDLE_WIDTH = 24;
const MIN_TRIM_MS = 500;
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${m}:${s.toString().padStart(2, '0')}.${frac}`;
}

interface ClipTrimModalProps {
  visible: boolean;
  clip: EditorClip | null;
  onSave: (trimStartMs: number, trimEndMs: number) => void;
  onDismiss: () => void;
}

export function ClipTrimModal({
  visible,
  clip,
  onSave,
  onDismiss,
}: ClipTrimModalProps) {
  const insets = useSafeAreaInsets();
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(-1);
  const durationMs = clip?.durationMs || 5000;

  // Reset when clip changes
  useEffect(() => {
    if (clip) {
      setStartMs(clip.trimStartMs);
      setEndMs(clip.trimEndMs === -1 ? durationMs : clip.trimEndMs);
    }
  }, [clip, durationMs]);

  const effectiveEndMs = endMs === -1 ? durationMs : endMs;
  const trimmedDuration = effectiveEndMs - startMs;

  // Keep refs always in sync so PanResponder closures read fresh values
  const startMsRef = useRef(startMs);
  const endMsRef = useRef(effectiveEndMs);
  const durationMsRef = useRef(durationMs);
  startMsRef.current = startMs;
  endMsRef.current = effectiveEndMs;
  durationMsRef.current = durationMs;

  // Track gesture start position to compute absolute position
  const startHandleOriginRef = useRef(0);
  const endHandleOriginRef = useRef(0);

  const startPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        // Capture the position at gesture start
        startHandleOriginRef.current = startMsRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        const dur = durationMsRef.current;
        const originMs = startHandleOriginRef.current;
        const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
        const newMs = Math.round(originMs + deltaMs);
        const clamped = Math.max(0, Math.min(newMs, endMsRef.current - MIN_TRIM_MS));
        setStartMs(clamped);
      },
    })
  ).current;

  const endPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        endHandleOriginRef.current = endMsRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        const dur = durationMsRef.current;
        const originMs = endHandleOriginRef.current;
        const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
        const newMs = Math.round(originMs + deltaMs);
        const clamped = Math.min(dur, Math.max(newMs, startMsRef.current + MIN_TRIM_MS));
        setEndMs(clamped);
      },
    })
  ).current;

  // Convert ms to timeline position
  const msToX = (ms: number) => (ms / durationMs) * TIMELINE_WIDTH;

  const handleReset = useCallback(() => {
    setStartMs(0);
    setEndMs(durationMs);
  }, [durationMs]);

  const handleSave = useCallback(() => {
    const finalEnd = endMs >= durationMs ? -1 : endMs;
    const finalStart = startMs <= 0 ? 0 : startMs;
    onSave(finalStart, finalEnd);
  }, [startMs, endMs, durationMs, onSave]);

  if (!clip) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDismiss}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 16,
        }}
      >
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
          <Pressable onPress={onDismiss} hitSlop={12}>
            <X size={24} color="#fff" />
          </Pressable>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
            Trim Clip
          </Text>
          <Pressable onPress={handleSave} hitSlop={12}>
            <Check size={24} color={theme.colors.primary} />
          </Pressable>
        </View>

        {/* Video preview area */}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {clip.sourceUri && isNative && ExpoVideo ? (
            <NativeTrimPlayer uri={clip.sourceUri} />
          ) : (
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
                Hole {clip.holeNumber} · Stroke {clip.shotNumber}
              </Text>
              <Text
                style={{
                  color: 'rgba(255,255,255,0.5)',
                  fontSize: 13,
                  marginTop: 4,
                }}
              >
                Video preview on device only
              </Text>
            </View>
          )}
        </View>

        {/* Duration info */}
        <View style={{ alignItems: 'center', paddingBottom: 12 }}>
          <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>
            {formatMs(trimmedDuration)}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            {formatMs(startMs)} — {formatMs(effectiveEndMs)}
          </Text>
        </View>

        {/* Timeline with handles */}
        <View style={{ paddingHorizontal: TIMELINE_PADDING, paddingBottom: 16 }}>
          {/* Track background */}
          <View
            style={{
              height: 48,
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 8,
              overflow: 'visible',
            }}
          >
            {/* Selected region highlight */}
            <View
              style={{
                position: 'absolute',
                left: msToX(startMs),
                width: msToX(effectiveEndMs) - msToX(startMs),
                height: '100%',
                backgroundColor: `${theme.colors.primary}40`,
                borderWidth: 2,
                borderColor: theme.colors.primary,
                borderRadius: 6,
              }}
            />

            {/* Start handle — wider hit area */}
            <View
              {...startPanResponder.panHandlers}
              style={{
                position: 'absolute',
                left: msToX(startMs) - HANDLE_WIDTH / 2,
                top: -4,
                width: HANDLE_WIDTH,
                height: 56,
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 10,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 28,
                  borderRadius: 3,
                  backgroundColor: theme.colors.primary,
                }}
              />
            </View>

            {/* End handle — wider hit area */}
            <View
              {...endPanResponder.panHandlers}
              style={{
                position: 'absolute',
                left: msToX(effectiveEndMs) - HANDLE_WIDTH / 2,
                top: -4,
                width: HANDLE_WIDTH,
                height: 56,
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 10,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 28,
                  borderRadius: 3,
                  backgroundColor: theme.colors.primary,
                }}
              />
            </View>
          </View>
        </View>

        {/* Reset button */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            paddingBottom: 16,
          }}
        >
          <Pressable
            onPress={handleReset}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: theme.radius.full,
              backgroundColor: 'rgba(255,255,255,0.1)',
            }}
          >
            <RotateCcw size={14} color="rgba(255,255,255,0.7)" />
            <Text
              style={{
                color: 'rgba(255,255,255,0.7)',
                fontSize: 13,
                fontWeight: '600',
              }}
            >
              Reset
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// Native video player for trim preview
function NativeTrimPlayer({ uri }: { uri: string }) {
  if (!ExpoVideo) return null;

  const { useVideoPlayer, VideoView } = ExpoVideo;
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.play();
  });

  return (
    <VideoView
      player={player}
      style={{ width: SCREEN_WIDTH, height: SCREEN_WIDTH * (16 / 9) }}
      contentFit="contain"
      nativeControls={false}
    />
  );
}
