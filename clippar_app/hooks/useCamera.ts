import { useRef, useState, useCallback, useEffect } from 'react';
import { Platform, InteractionManager } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraView } from 'expo-camera';
import type { ClipMetadata } from '@/types/round';
import type { ShotTypeClassification } from 'shot-detector';
import {
  saveLocalClip,
  updateClipEditorState,
  markClipTrimmed,
  getSetting,
} from '@/lib/storage';
import { detectAndTrim } from 'shot-detector';
import { config } from '@/constants/config';
import { enqueueClipUpload } from '@/lib/uploadQueue';

// Read user-configured pre/post roll from SQLite, falling back to config defaults.
// Mirrors useEditorState.getTrimSettings so live record uses the same numbers as import.
async function loadTrimSettings(): Promise<{ preRollMs: number; postRollMs: number }> {
  let preRollMs = config.trim.defaultPreRollMs;
  let postRollMs = config.trim.defaultPostRollMs;
  try {
    const saved = await getSetting('trim_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.preRollMs) preRollMs = parsed.preRollMs;
      if (parsed.postRollMs) postRollMs = parsed.postRollMs;
    }
  } catch {}
  return { preRollMs, postRollMs };
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Dynamically import native-only modules
const KeepAwake = isNative
  ? (require('expo-keep-awake') as typeof import('expo-keep-awake'))
  : null;

interface UseCameraParams {
  roundId: string;
  holeNumber: number;
  shotNumber: number;
  getLocation?: () => Promise<{ latitude: number; longitude: number } | null>;
  onClipSaved?: (clip: ClipMetadata) => void;
  onShotClassified?: (shotType: ShotTypeClassification) => void;
}

export function useCamera({
  roundId,
  holeNumber,
  shotNumber,
  getLocation,
  onClipSaved,
  onShotClassified,
}: UseCameraParams) {
  const cameraRef = useRef<CameraView>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const isRecordingRef = useRef(false);
  const recordingStartTime = useRef<number>(0);
  const lastToggleTime = useRef<number>(0);

  // Keep refs in sync with params (they change each shot)
  const paramsRef = useRef({ roundId, holeNumber, shotNumber });
  useEffect(() => {
    paramsRef.current = { roundId, holeNumber, shotNumber };
  }, [roundId, holeNumber, shotNumber]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isNative) {
      setHasPermission(false);
      return false;
    }
    try {
      const { Camera } = require('expo-camera');
      const [camResult, micResult] = await Promise.all([
        Camera.requestCameraPermissionsAsync(),
        Camera.requestMicrophonePermissionsAsync(),
      ]);
      const granted =
        camResult.status === 'granted' && micResult.status === 'granted';
      setHasPermission(granted);
      return granted;
    } catch {
      setHasPermission(false);
      return false;
    }
  }, []);

  // Check permission on mount (native only)
  useEffect(() => {
    if (isNative) {
      requestPermission();
    }
  }, [requestPermission]);

  const startRecording = useCallback(async () => {
    if (!isNative || !cameraRef.current || isRecordingRef.current) return;

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      isRecordingRef.current = true;
      setIsRecording(true);
      recordingStartTime.current = Date.now();

      // Keep screen awake
      KeepAwake?.activateKeepAwakeAsync('recording');

      const { roundId: rid, holeNumber: hole, shotNumber: shot } = paramsRef.current;

      // Small delay to ensure camera is ready (avoids "error while recording" on iOS)
      await new Promise((r) => setTimeout(r, 200));

      if (!cameraRef.current || !isRecordingRef.current) return;

      // Note: videoQuality must be set as a PROP on <CameraView> (in record.tsx),
      // not passed to recordAsync. It's not a valid recordAsync option.
      const video = await cameraRef.current.recordAsync({
        maxDuration: 120,
      });

      // Recording stopped — process the clip
      if (video?.uri) {
        const finalUri = video.uri;
        const durationSeconds = (Date.now() - recordingStartTime.current) / 1000;

        // Get GPS if available
        let gps: { latitude: number; longitude: number } | null = null;
        if (getLocation) {
          try {
            gps = await getLocation();
          } catch {
            // GPS optional
          }
        }

        // Save to SQLite — same initial shape as imports (needs_trim=1, auto_trimmed=0,
        // original_file_uri=finalUri). detectAndTrim will promote it to auto_trimmed=1
        // and swap file_uri to the trimmed file. If detection fails, the editor's
        // processAllUntrimmed pass will retry using the same detectAndTrim path.
        const clipId = await saveLocalClip({
          round_id: rid,
          hole_number: hole,
          shot_number: shot,
          file_uri: finalUri,
          original_file_uri: finalUri,
          gps_latitude: gps?.latitude,
          gps_longitude: gps?.longitude,
          duration_seconds: durationSeconds,
          auto_trimmed: 0,
          needs_trim: 1,
          trim_start_ms: 0,
          trim_end_ms: -1,
        });

        // Run the SAME native detect+trim pipeline as imports in background.
        // This produces a trimmed passthrough file, persists boundaries relative
        // to the original, and classifies the shot for hole auto-advance.
        //
        // Defer off the gesture-handler/recordAsync resolution so the JS thread
        // can finish updating React state (isRecording=false, button resets)
        // before we kick off heavy detection + file I/O. Without this the stop
        // tap can visibly "lag" by a second or more on lower-end devices.
        InteractionManager.runAfterInteractions(() => {
          loadTrimSettings().then(async ({ preRollMs, postRollMs }) => {
          try {
            const result = await detectAndTrim(finalUri, preRollMs, postRollMs);
            if (!clipId) return;

            if (result.found && result.trimmedUri) {
              // Swing detected + trimmed file produced
              console.log(
                `[ShotDetector] Swing @ ${result.impactTimeMs}ms ` +
                  `(conf ${result.confidence.toFixed(2)}) → trim ${result.trimStartMs}..${result.trimEndMs}ms`
              );
              await markClipTrimmed(
                clipId,
                result.trimmedUri,
                result.impactTimeMs,
                result.confidence,
                result.trimStartMs,
                result.trimEndMs
              ).catch(() => {});
              await updateClipEditorState(clipId, {
                trim_start_ms: Math.round(result.trimStartMs),
                trim_end_ms: Math.round(result.trimEndMs),
                shot_type: result.shotType,
              }).catch(() => {});
              onShotClassified?.(result.shotType);
            } else if (result.found && result.shotType === 'putt') {
              // Putt — no trim file, keep full original
              console.log(
                `[ShotDetector] Putt @ ${result.impactTimeMs}ms ` +
                  `(conf ${result.confidence.toFixed(2)}) — keeping full clip`
              );
              await markClipTrimmed(
                clipId,
                finalUri,
                result.impactTimeMs,
                result.confidence
              ).catch(() => {});
              await updateClipEditorState(clipId, {
                trim_start_ms: 0,
                trim_end_ms: -1,
                shot_type: 'putt',
              }).catch(() => {});
              onShotClassified?.('putt');
            } else {
              // No usable detection — still mark as processed so editor won't retry
              console.log('[ShotDetector] No swing detected — keeping full clip, mark processed');
              await markClipTrimmed(clipId, finalUri, null, null).catch(() => {});
              // Assume swing for hole-advance purposes; the auto-advance logic
              // is tolerant of bogus classifications across many clips.
              onShotClassified?.('swing');
            }
          } catch (err) {
            console.log('[ShotDetector] Detection error (non-fatal):', err);
          }
          });
        });

        const clip: ClipMetadata = {
          roundId: rid,
          holeNumber: hole,
          shotNumber: shot,
          fileUri: finalUri,
          gpsLatitude: gps?.latitude,
          gpsLongitude: gps?.longitude,
          durationSeconds,
          timestamp: new Date().toISOString(),
          uploaded: false,
        };

        onClipSaved?.(clip);

        // Auto-upload in background so the clip reaches Supabase Storage
        // without waiting for the user to hit "Finish round". The queue is
        // idempotent — calling it once per clip is fine. Defer this too so
        // it doesn't race detection or block the stop gesture.
        InteractionManager.runAfterInteractions(() => {
          void enqueueClipUpload(rid, null);
        });
      }
    } catch (error) {
      console.error('[useCamera] Recording error:', error);
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
      KeepAwake?.deactivateKeepAwake('recording');
    }
  }, [getLocation, onClipSaved, onShotClassified]);

  const stopRecording = useCallback(async () => {
    if (!isNative || !cameraRef.current || !isRecordingRef.current) return;

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      cameraRef.current.stopRecording();
      // The recordAsync promise in startRecording will resolve with the video
    } catch (error) {
      console.error('[useCamera] Stop recording error:', error);
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  }, []);

  const toggleRecording = useCallback(async () => {
    // Debounce — ignore rapid double-fires from shutter (volume + key event).
    // 200ms is enough to swallow the doubled event without making a genuine
    // "start, wait ~300ms, try stop" interaction feel unresponsive.
    const now = Date.now();
    if (now - lastToggleTime.current < 200) return;
    lastToggleTime.current = now;

    if (isRecordingRef.current) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [startRecording, stopRecording]);

  // Web stubs for development
  const simulateRecording = useCallback(async () => {
    if (isNative) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    if (isRecordingRef.current) {
      // Stop simulated recording
      isRecordingRef.current = false;
      setIsRecording(false);

      const { roundId: rid, holeNumber: hole, shotNumber: shot } = paramsRef.current;

      const clip: ClipMetadata = {
        roundId: rid,
        holeNumber: hole,
        shotNumber: shot,
        fileUri: `simulated_${rid}_hole${hole}_shot${shot}.mp4`,
        durationSeconds: 5,
        timestamp: new Date().toISOString(),
        uploaded: false,
      };

      await saveLocalClip({
        round_id: rid,
        hole_number: hole,
        shot_number: shot,
        file_uri: clip.fileUri,
        duration_seconds: 5,
      });

      onClipSaved?.(clip);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      // Start simulated recording
      isRecordingRef.current = true;
      setIsRecording(true);
    }
  }, [onClipSaved]);

  return {
    cameraRef,
    isRecording,
    hasPermission,
    requestPermission,
    startRecording,
    stopRecording,
    toggleRecording,
    simulateRecording,
  };
}
