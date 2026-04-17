import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  PanResponder,
  Dimensions,
  Platform,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, RotateCcw } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import type { EditorClip } from '@/types/editor';
import { trimVideo } from 'shot-detector';

const VideoThumbnails = Platform.OS !== 'web'
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const TIMELINE_PADDING = 24;
const TIMELINE_WIDTH = SCREEN_WIDTH - TIMELINE_PADDING * 2;
const HANDLE_WIDTH = 28;
const MIN_TRIM_MS = 500;
const LOOP_POLL_MS = 50;
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

const ExpoAV = isNative
  ? (require('expo-av') as typeof import('expo-av'))
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
  onSave: (
    trimStartMs: number,
    trimEndMs: number,
    sourceOverride?: { sourceUri: string; durationMs: number },
  ) => void;
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
  const [durationMs, setDurationMs] = useState(clip?.durationMs || 5000);
  const [activeUri, setActiveUri] = useState<string | null>(clip?.sourceUri ?? null);
  const [savingTrim, setSavingTrim] = useState(false);

  // Track which handle was last released so the player seeks to the right position
  const [seekTarget, setSeekTarget] = useState<'start' | 'end'>('start');

  // Track which handle is actively being dragged for real-time scrubbing
  const [draggingHandle, setDraggingHandle] = useState<'none' | 'start' | 'end'>('none');

  // Bump this counter to signal the player to seek
  const [seekGeneration, setSeekGeneration] = useState(0);

  // Probe duration of a video URI using ExpoAV
  const probeDuration = useCallback(async (uri: string): Promise<number> => {
    if (!ExpoAV) return 5000;
    try {
      const { sound, status } = await ExpoAV.Audio.Sound.createAsync(
        { uri },
        {},
        undefined,
        false,
      );
      const dur = status.isLoaded && status.durationMillis ? status.durationMillis : 5000;
      await sound.unloadAsync();
      return dur;
    } catch {
      return 5000;
    }
  }, []);

  // Reset when clip changes — auto-probe original if available
  useEffect(() => {
    if (!clip) return;
    let cancelled = false;

    const init = async () => {
      // If auto-trimmed and original exists, use original as the timeline source
      if (clip.autoTrimmed && clip.originalUri && clip.originalUri !== clip.sourceUri) {
        const origDur = await probeDuration(clip.originalUri);
        if (cancelled) return;
        setDurationMs(origDur);
        setActiveUri(clip.originalUri);
        setStartMs(clip.trimStartMs);
        setEndMs(clip.trimEndMs === -1 ? origDur : clip.trimEndMs);
      } else {
        // Non-auto-trimmed: use sourceUri directly
        const dur = clip.durationMs || 5000;
        setDurationMs(dur);
        setActiveUri(clip.sourceUri);
        setStartMs(clip.trimStartMs);
        setEndMs(clip.trimEndMs === -1 ? dur : clip.trimEndMs);
      }
      if (!cancelled) setSeekGeneration((g) => g + 1);
    };

    init();
    return () => { cancelled = true; };
  }, [clip, probeDuration]);

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
          setDraggingHandle('start');
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
          setDraggingHandle('none');
          setSeekTarget('start');
          triggerSeek();
        },
        onPanResponderTerminate: () => {
          setDraggingHandle('none');
          setSeekTarget('start');
          triggerSeek();
        },
      }),
    [triggerSeek, setDraggingHandle],
  );

  const endPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          endHandleOriginRef.current = endMsRef.current;
          setDraggingHandle('end');
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
          setDraggingHandle('none');
          setSeekTarget('end');
          triggerSeek();
        },
        onPanResponderTerminate: () => {
          setDraggingHandle('none');
          setSeekTarget('end');
          triggerSeek();
        },
      }),
    [triggerSeek, setDraggingHandle],
  );

  // Convert ms to timeline position
  const msToX = (ms: number) => (ms / durationMs) * TIMELINE_WIDTH;

  const handleReset = useCallback(() => {
    setStartMs(0);
    setEndMs(durationMs);
    // Seek after reset
    setTimeout(() => setSeekGeneration((g) => g + 1), 0);
  }, [durationMs]);

  const handleSave = useCallback(async () => {
    const finalEnd = endMs >= durationMs ? -1 : endMs;
    const finalStart = startMs <= 0 ? 0 : startMs;

    // If editing from the original video, re-trim to create a new file
    if (clip?.autoTrimmed && activeUri && activeUri === clip?.originalUri) {
      setSavingTrim(true);
      try {
        const trimEnd = finalEnd === -1 ? durationMs : finalEnd;
        const result = await trimVideo(activeUri, finalStart, trimEnd);
        onSave(finalStart, finalEnd, {
          sourceUri: result.trimmedUri,
          durationMs: trimEnd - finalStart,
        });
      } catch (err) {
        console.warn('[ClipTrimModal] Re-trim failed, saving offsets only:', err);
        onSave(finalStart, finalEnd);
      } finally {
        setSavingTrim(false);
      }
    } else {
      onSave(finalStart, finalEnd);
    }
  }, [startMs, endMs, durationMs, onSave, activeUri, clip?.autoTrimmed, clip?.originalUri]);

  // Generate filmstrip thumbnails
  const THUMB_COUNT = 15;
  const THUMB_WIDTH = Math.floor(TIMELINE_WIDTH / THUMB_COUNT);
  const [filmstripThumbs, setFilmstripThumbs] = useState<(string | null)[]>([]);

  useEffect(() => {
    if (!visible || !activeUri || !isNative || !VideoThumbnails) {
      setFilmstripThumbs([]);
      return;
    }

    let cancelled = false;
    const generateThumbs = async () => {
      const thumbs: (string | null)[] = new Array(THUMB_COUNT).fill(null);
      const interval = durationMs / THUMB_COUNT;

      // Generate all thumbs concurrently for speed
      const promises = Array.from({ length: THUMB_COUNT }, async (_, i) => {
        if (cancelled) return;
        try {
          const time = Math.round(i * interval + interval / 2);
          const result = await VideoThumbnails!.getThumbnailAsync(activeUri!, {
            time,
            quality: 0.3,
          });
          if (!cancelled) {
            thumbs[i] = result.uri;
          }
        } catch {}
      });

      await Promise.all(promises);
      if (!cancelled) {
        setFilmstripThumbs([...thumbs]);
      }
    };

    generateThumbs();
    return () => { cancelled = true; };
  }, [visible, activeUri, durationMs]);

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
            zIndex: 10,
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
            disabled={savingTrim}
            hitSlop={12}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: theme.colors.primary,
              justifyContent: 'center',
              alignItems: 'center',
              opacity: savingTrim ? 0.5 : 1,
            }}
          >
            <Check size={20} color="#fff" />
          </Pressable>
        </View>

        {/* Video preview area */}
        <View
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}
        >
          {activeUri && isNative && ExpoVideo ? (
            <NativeTrimPlayer
              uri={activeUri}
              startMs={startMs}
              endMs={effectiveEndMs}
              seekGeneration={seekGeneration}
              seekTarget={seekTarget}
              draggingHandle={draggingHandle}
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

          {/* Track background with filmstrip thumbnails */}
          <View
            style={{
              height: 48,
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 8,
              overflow: 'visible',
            }}
          >
            {/* Filmstrip thumbnails */}
            {filmstripThumbs.length > 0 && (
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  flexDirection: 'row',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {filmstripThumbs.map((thumbUri, i) => (
                  <View key={i} style={{ width: THUMB_WIDTH, height: 48 }}>
                    {thumbUri ? (
                      <Image
                        source={{ uri: thumbUri }}
                        style={{ width: THUMB_WIDTH, height: 48 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={{ width: THUMB_WIDTH, height: 48, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                    )}
                  </View>
                ))}
              </View>
            )}
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

        {/* Action buttons */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 12,
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

          {/* Saving indicator */}
          {savingTrim && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: theme.radius.full,
                backgroundColor: `${theme.colors.primary}30`,
              }}
            >
              <Text
                style={{
                  color: theme.colors.primary,
                  fontSize: 13,
                  fontWeight: '600',
                }}
              >
                Saving...
              </Text>
            </View>
          )}
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
  seekTarget = 'start',
  draggingHandle = 'none',
}: {
  uri: string;
  startMs: number;
  endMs: number;
  seekGeneration: number;
  seekTarget?: 'start' | 'end';
  draggingHandle?: 'none' | 'start' | 'end';
}) {
  if (!ExpoVideo) return null;

  const { useVideoPlayer, VideoView } = ExpoVideo;

  // Keep refs for the polling interval to read
  const startSecRef = useRef(startMs / 1000);
  const endSecRef = useRef(endMs / 1000);
  const draggingRef = useRef(draggingHandle);
  startSecRef.current = startMs / 1000;
  endSecRef.current = endMs / 1000;
  draggingRef.current = draggingHandle;

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false; // We handle looping manually to respect trim bounds
    p.currentTime = startSecRef.current;
    p.play();
  });

  // Real-time scrubbing: pause and seek to the relevant frame while a handle is being dragged
  useEffect(() => {
    if (draggingHandle === 'end') {
      player.pause();
      player.currentTime = Math.max(0, endSecRef.current - 0.1);
    } else if (draggingHandle === 'start') {
      player.pause();
      player.currentTime = startSecRef.current;
    }
    // When draggingHandle === 'none', don't interfere — let seekGeneration effect handle it
  }, [draggingHandle, startMs, endMs, player]);

  // Seek when handle is released — left handle seeks to start, right handle seeks to end
  useEffect(() => {
    if (seekGeneration > 0) {
      player.currentTime = seekTarget === 'end'
        ? Math.max(0, endSecRef.current - 0.1)
        : startSecRef.current;
      player.play();
    }
  }, [seekGeneration, player, seekTarget]);

  // Poll currentTime to loop between trim points (skip while dragging)
  useEffect(() => {
    const interval = setInterval(() => {
      if (draggingRef.current !== 'none') return; // Don't interfere during drag
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

  // Cap video height to fit within modal (leave room for header, timeline, controls)
  const maxVideoHeight = SCREEN_HEIGHT * 0.5;
  const idealHeight = SCREEN_WIDTH * (16 / 9);
  const videoHeight = Math.min(idealHeight, maxVideoHeight);
  const videoWidth = videoHeight < idealHeight
    ? videoHeight * (9 / 16)
    : SCREEN_WIDTH;

  return (
    <VideoView
      player={player}
      style={{ width: videoWidth, height: videoHeight }}
      contentFit="contain"
      nativeControls={false}
    />
  );
}
