import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
const HANDLE_WIDTH = 28;
const MIN_TRIM_MS = 500;
const LOOP_POLL_MS = 50;
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

function formatMs(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(1)}s`;
}

function formatMsFull(ms: number): string {
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

  // Bump this counter to signal the player to seek to startMs
  const [seekGeneration, setSeekGeneration] = useState(0);

  // Reset when clip changes
  useEffect(() => {
    if (clip) {
      setStartMs(clip.trimStartMs);
      setEndMs(clip.trimEndMs === -1 ? durationMs : clip.trimEndMs);
      setSeekGeneration((g) => g + 1);
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

  const triggerSeek = useCallback(() => {
    setSeekGeneration((g) => g + 1);
  }, []);

  const startPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startHandleOriginRef.current = startMsRef.current;
        },
        onPanResponderMove: (_, gestureState) => {
          const dur = durationMsRef.current;
          const originMs = startHandleOriginRef.current;
          const deltaMs = (gestureState.dx / TIMELINE_WIDTH) * dur;
          const newMs = Math.round(originMs + deltaMs);
          const clamped = Math.max(
            0,
            Math.min(newMs, endMsRef.current - MIN_TRIM_MS),
          );
          setStartMs(clamped);
        },
        onPanResponderRelease: () => {
          // After releasing the left handle, seek to left handle and play
          triggerSeek();
        },
        onPanResponderTerminate: () => {
          triggerSeek();
        },
      }),
    [triggerSeek],
  );

  const endPanResponder = useMemo(
    () =>
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
          const clamped = Math.min(
            dur,
            Math.max(newMs, startMsRef.current + MIN_TRIM_MS),
          );
          setEndMs(clamped);
        },
        onPanResponderRelease: () => {
          // After releasing the right handle, seek to left handle and play through
          triggerSeek();
        },
        onPanResponderTerminate: () => {
          triggerSeek();
        },
      }),
    [triggerSeek],
  );

  // Convert ms to timeline position
  const msToX = (ms: number) => (ms / durationMs) * TIMELINE_WIDTH;

  const handleReset = useCallback(() => {
    setStartMs(0);
    setEndMs(durationMs);
    // Seek after reset
    setTimeout(() => setSeekGeneration((g) => g + 1), 0);
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
          paddingTop: Platform.OS === 'ios' ? 10 : 16,
          paddingBottom: insets.bottom + 16,
        }}
      >
        {/* Drag indicator for iOS pageSheet */}
        {Platform.OS === 'ios' && (
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 2.5,
                backgroundColor: 'rgba(255,255,255,0.3)',
              }}
            />
          </View>
        )}

        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(255,255,255,0.12)',
          }}
        >
          <Pressable
            onPress={onDismiss}
            hitSlop={12}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: 'rgba(255,255,255,0.15)',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <X size={20} color="#fff" />
          </Pressable>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
            Trim Clip
          </Text>
          <Pressable
            onPress={handleSave}
            hitSlop={12}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: theme.colors.primary,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Check size={20} color="#fff" />
          </Pressable>
        </View>

        {/* Video preview area */}
        <View
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
        >
          {clip.sourceUri && isNative && ExpoVideo ? (
            <NativeTrimPlayer
              uri={clip.sourceUri}
              startMs={startMs}
              endMs={effectiveEndMs}
              seekGeneration={seekGeneration}
            />
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
            {formatMsFull(trimmedDuration)}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            {formatMsFull(startMs)} — {formatMsFull(effectiveEndMs)}
          </Text>
        </View>

        {/* Timeline with handles */}
        <View style={{ paddingHorizontal: TIMELINE_PADDING, paddingBottom: 16 }}>
          {/* Time labels above handles */}
          <View style={{ height: 20, position: 'relative', marginBottom: 4 }}>
            <Text
              style={{
                position: 'absolute',
                left: Math.max(0, msToX(startMs) - 20),
                color: theme.colors.primary,
                fontSize: 11,
                fontWeight: '600',
                width: 50,
                textAlign: 'center',
              }}
            >
              {formatMs(startMs)}
            </Text>
            <Text
              style={{
                position: 'absolute',
                left: Math.min(
                  TIMELINE_WIDTH - 50,
                  Math.max(0, msToX(effectiveEndMs) - 25),
                ),
                color: theme.colors.primary,
                fontSize: 11,
                fontWeight: '600',
                width: 50,
                textAlign: 'center',
              }}
            >
              {formatMs(effectiveEndMs)}
            </Text>
          </View>

          {/* Track background */}
          <View
            style={{
              height: 48,
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 8,
              overflow: 'visible',
            }}
          >
            {/* Dimmed left region */}
            {startMs > 0 && (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  width: msToX(startMs),
                  height: '100%',
                  backgroundColor: 'rgba(0,0,0,0.5)',
                  borderTopLeftRadius: 8,
                  borderBottomLeftRadius: 8,
                }}
              />
            )}

            {/* Dimmed right region */}
            {effectiveEndMs < durationMs && (
              <View
                style={{
                  position: 'absolute',
                  left: msToX(effectiveEndMs),
                  right: 0,
                  width: TIMELINE_WIDTH - msToX(effectiveEndMs),
                  height: '100%',
                  backgroundColor: 'rgba(0,0,0,0.5)',
                  borderTopRightRadius: 8,
                  borderBottomRightRadius: 8,
                }}
              />
            )}

            {/* Selected region highlight */}
            <View
              style={{
                position: 'absolute',
                left: msToX(startMs),
                width: msToX(effectiveEndMs) - msToX(startMs),
                height: '100%',
                backgroundColor: `${theme.colors.primary}30`,
                borderWidth: 2,
                borderColor: theme.colors.primary,
                borderRadius: 6,
              }}
            />

            {/* Start handle */}
            <View
              {...startPanResponder.panHandlers}
              style={{
                position: 'absolute',
                left: msToX(startMs) - HANDLE_WIDTH / 2,
                top: -6,
                width: HANDLE_WIDTH,
                height: 60,
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 10,
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 32,
                  borderRadius: 4,
                  backgroundColor: theme.colors.primary,
                }}
              />
            </View>

            {/* End handle */}
            <View
              {...endPanResponder.panHandlers}
              style={{
                position: 'absolute',
                left: msToX(effectiveEndMs) - HANDLE_WIDTH / 2,
                top: -6,
                width: HANDLE_WIDTH,
                height: 60,
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 10,
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 32,
                  borderRadius: 4,
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

// ---- Native video player that loops between trim points ----

function NativeTrimPlayer({
  uri,
  startMs,
  endMs,
  seekGeneration,
}: {
  uri: string;
  startMs: number;
  endMs: number;
  seekGeneration: number;
}) {
  if (!ExpoVideo) return null;

  const { useVideoPlayer, VideoView } = ExpoVideo;

  // Keep refs for the polling interval to read
  const startSecRef = useRef(startMs / 1000);
  const endSecRef = useRef(endMs / 1000);
  startSecRef.current = startMs / 1000;
  endSecRef.current = endMs / 1000;

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false; // We handle looping manually to respect trim bounds
    p.currentTime = startSecRef.current;
    p.play();
  });

  // Seek to startMs whenever seekGeneration changes (i.e., handle released)
  useEffect(() => {
    if (seekGeneration > 0) {
      player.currentTime = startSecRef.current;
      player.play();
    }
  }, [seekGeneration, player]);

  // Poll currentTime to loop between trim points
  useEffect(() => {
    const interval = setInterval(() => {
      const currentTime = player.currentTime;
      const endSec = endSecRef.current;
      const startSec = startSecRef.current;

      // If playback has reached or passed the right trim point, loop back
      if (currentTime >= endSec - 0.03) {
        player.currentTime = startSec;
        player.play();
      }
    }, LOOP_POLL_MS);

    return () => clearInterval(interval);
  }, [player]);

  // Also listen for playToEnd in case the right trim is at/near the end
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      player.currentTime = startSecRef.current;
      player.play();
    });
    return () => sub.remove();
  }, [player]);

  return (
    <VideoView
      player={player}
      style={{ width: SCREEN_WIDTH, height: SCREEN_WIDTH * (16 / 9) }}
      contentFit="contain"
      nativeControls={false}
    />
  );
}
