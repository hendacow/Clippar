import { useRef, useState, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraView } from 'expo-camera';
import type { ClipMetadata } from '@/types/round';
import { saveLocalClip } from '@/lib/storage';

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
}

export function useCamera({
  roundId,
  holeNumber,
  shotNumber,
  getLocation,
  onClipSaved,
}: UseCameraParams) {
  const cameraRef = useRef<CameraView>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const isRecordingRef = useRef(false);
  const recordingStartTime = useRef<number>(0);

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
      const { status } = await Camera.requestCameraPermissionsAsync();
      const granted = status === 'granted';
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

        // Save to SQLite
        await saveLocalClip({
          round_id: rid,
          hole_number: hole,
          shot_number: shot,
          file_uri: finalUri,
          gps_latitude: gps?.latitude,
          gps_longitude: gps?.longitude,
          duration_seconds: durationSeconds,
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
      }
    } catch (error) {
      console.error('[useCamera] Recording error:', error);
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
      KeepAwake?.deactivateKeepAwake('recording');
    }
  }, [getLocation, onClipSaved]);

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
