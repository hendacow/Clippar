import { useRef, useState, useCallback, useEffect } from 'react';
import { Alert, AppState, Platform, InteractionManager } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraView } from 'expo-camera';
import type { ClipMetadata } from '@/types/round';
import type { ShotTypeClassification, DetectionStrategy } from 'shot-detector';
import {
  saveLocalClip,
  updateClipEditorState,
  markClipTrimmed,
  getSetting,
  clipExists,
} from '@/lib/storage';
import { detectAndTrim, deleteFile, getDevicePitchDeg, getMemoryStats } from 'shot-detector';
import { config } from '@/constants/config';
import { enqueueClipUpload } from '@/lib/uploadQueue';
import { logDetection } from '@/lib/detectionLog';
import { visionDetectAndTrim } from '@/lib/visionTrim';
import { canStartRecording, resolveStopRequest } from '@/lib/liveRecordingLogic';
import { markTrimInFlight, clearTrimInFlight } from '@/lib/trimInFlight';

// Resolve the active trim window (pre/post roll). Mirrors
// useEditorState.getTrimSettings so live record uses the same numbers as import.
//
// FIX #8 — full-swing window must win over a stale saved override.
// The DEFAULT is now config.trim.windows.fullSwing (2500/1500, ~4s total),
// NOT the legacy defaultPreRollMs/defaultPostRollMs (3000/2000). A saved
// 'trim_settings' override is only honored when the user EXPLICITLY opted into
// the new window (parsed.window === 'fullSwing'). Overrides written before this
// change carry no `window` marker (or carry the old 3000/2000 numbers), so they
// are intentionally ignored here — otherwise they would silently shadow the new
// fullSwing window and day-zero clips would keep trimming to the old length.
async function loadTrimSettings(): Promise<{ preRollMs: number; postRollMs: number }> {
  let { preRollMs, postRollMs } = config.trim.windows.fullSwing;
  try {
    const saved = await getSetting('trim_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Only an explicit fullSwing-tagged override may replace the config window.
      if (parsed.window === 'fullSwing') {
        if (parsed.preRollMs) preRollMs = parsed.preRollMs;
        if (parsed.postRollMs) postRollMs = parsed.postRollMs;
      }
    }
  } catch {}
  // Tracer hook (no-op at the default 0): a longer post-impact window keeps
  // more ball flight in the trimmed clip for the arc draw-on. Gated on
  // config.tracer.enabled so day-zero behavior is byte-identical. Mirrored in
  // useEditorState.getTrimSettings so import re-trims match live record.
  if (config.tracer.enabled && config.tracer.extraPostRollMs > 0) {
    postRollMs += config.tracer.extraPostRollMs;
  }
  return { preRollMs, postRollMs };
}

// Resolve the configured detection strategy + options for the native dispatch.
// Defaults come from config.detection; passed positionally to detectAndTrim so
// the 6-arg native arity is always satisfied via the JS wrapper.
function resolveDetection(
  extraOptions?: Record<string, unknown>
): { strategy: DetectionStrategy; optionsJson: string } {
  const strategy = config.detection.strategy;
  const options = { ...(config.detection.options ?? {}), ...(extraOptions ?? {}) };
  return { strategy, optionsJson: JSON.stringify(options) };
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Refuse to start a recording with less free disk than this. Untrimmed 1080p
// clips run up to 120s (~150MB) and the pipeline keeps original + trimmed
// (+ tracer) files per shot — on a nearly-full phone every finalize fails
// with the generic "error occurred while recording" and the user silently
// loses the rest of the round. Better to say so up front.
const MIN_FREE_DISK_MB = 500;

// Safety valve for the finalizing gate: if the recordAsync pipeline somehow
// never settles (native finalize normally takes 5-10s), unblock the record
// button rather than leaving it bricked for the rest of the round.
const FINALIZE_SAFETY_MS = 30_000;

// Dynamically import native-only modules
const KeepAwake = isNative
  ? (require('expo-keep-awake') as typeof import('expo-keep-awake'))
  : null;

interface UseCameraParams {
  roundId: string;
  holeNumber: number;
  shotNumber: number;
  getLocation?: () => Promise<{
    latitude: number;
    longitude: number;
    // Horizontal accuracy radius (m). Additive — useLocation now reports it;
    // the tracer pipeline gates landing-spot pairing on it (gps_accuracy_m).
    accuracy?: number | null;
  } | null>;
  /**
   * Tracer capture: compass azimuth of the camera optical axis, sampled at
   * record start (useLocation.getCurrentHeading — non-prompting per F13).
   * Only fired when config.tracer.enabled && config.tracer.captureHeading.
   */
  getHeading?: () => Promise<{
    headingDeg: number;
    isTrue: boolean;
    calibration: number;
  } | null>;
  onClipSaved?: (clip: ClipMetadata) => void;
  onShotClassified?: (shotType: ShotTypeClassification) => void;
  /**
   * Practice mode (clicker tutorial). When true, the camera records and the
   * isRecording state toggles normally — so the user SEES recording happen —
   * but on stop the captured video is discarded: no clip is saved to SQLite,
   * no upload is queued, and onClipSaved / onShotClassified are NOT fired.
   * This lets the tutorial run a live dry-run on the real round without
   * polluting it. Captured at recording-start time so a clip started during
   * practice is always discarded even if practice ends mid-finalize.
   */
  practice?: boolean;
}

export function useCamera({
  roundId,
  holeNumber,
  shotNumber,
  getLocation,
  getHeading,
  onClipSaved,
  onShotClassified,
  practice = false,
}: UseCameraParams) {
  const cameraRef = useRef<CameraView>(null);
  // Mirror `practice` into a ref so startRecording can capture its value at
  // the moment recording begins (the recordAsync promise resolves later).
  const practiceRef = useRef(practice);
  practiceRef.current = practice;
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const isRecordingRef = useRef(false);
  const recordingStartTime = useRef<number>(0);
  const lastToggleTime = useRef<number>(0);
  // True from the stop press until the recordAsync save pipeline settles
  // (the native MP4 finalize takes 5-10s). While set, new starts are
  // blocked: calling recordAsync against a still-finalizing movie output
  // makes the native side silently no-op (promise never settles — REC shows
  // while nothing records) or reject with the generic recording error.
  const [isFinalizing, setIsFinalizing] = useState(false);
  const isFinalizingRef = useRef(false);
  // Monotonic recording generation. The shared `finally` of an OLD
  // startRecording invocation must never clobber the state of a NEWER
  // recording (UI flipping to idle / KeepAwake dropping while the camera is
  // genuinely recording), so state resets are gated on the generation still
  // being current.
  const recordingGenRef = useRef(0);
  // Generation whose clip should be DISCARDED on resolve: set when a <2s
  // stop is forced (on-screen button / tutorial end) — the too-short file
  // can't contain a shot and often fails finalize, so we swallow both the
  // file and the expected error instead of surfacing S2.
  const cancelledGenRef = useRef(0);
  const finalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      // Unique marker so we can verify which bundle is loaded.
      // bundle-id: cam-fix-v2
      console.log('[useCamera] mounted — bundle cam-fix-v2');
      requestPermission();
    }
  }, [requestPermission]);

  // Configure iOS audio session for recording BEFORE the camera attempts
  // to attach the mic. The editor's expo-av playback puts the session in
  // playback-only mode; without resetting to PlayAndRecord-compatible state,
  // AVCaptureSession dies with -10868 (kAudioUnitErr_FormatNotSupported)
  // ~2s after recordAsync starts. MixWithOthers (default) avoids exclusive
  // ownership which itself breaks format negotiation.
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    (async () => {
      try {
        const ExpoAV = require('expo-av') as typeof import('expo-av');
        if (cancelled) return;
        await ExpoAV.Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          interruptionModeIOS: ExpoAV.InterruptionModeIOS.MixWithOthers,
          shouldDuckAndroid: false,
          interruptionModeAndroid: ExpoAV.InterruptionModeAndroid.DoNotMix,
          playThroughEarpieceAndroid: false,
        });
        console.log('[useCamera] audio mode set for recording');
      } catch (err) {
        console.log('[useCamera] setAudioMode failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const startRecording = useCallback(async () => {
    if (!isNative || !cameraRef.current) return;
    if (
      !canStartRecording({
        isRecording: isRecordingRef.current,
        isFinalizing: isFinalizingRef.current,
      })
    ) {
      // A press during the previous clip's 5-10s finalize window used to
      // reach recordAsync on a busy movie output — native record() no-ops
      // without settling the promise, so REC showed while nothing recorded.
      console.log('[useCamera] start ignored — previous clip still finalizing');
      return;
    }

    // Capture practice mode AT START. If the tutorial started this clip, we
    // discard it on stop regardless of whether practice mode is still on by
    // the time recordAsync resolves.
    const isPractice = practiceRef.current;
    const gen = ++recordingGenRef.current;

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      isRecordingRef.current = true;
      setIsRecording(true);
      recordingStartTime.current = Date.now();

      // Disk-space preflight: on a nearly-full phone every finalize fails
      // with the generic recording error and the shot silently vanishes.
      // getMemoryStats returns -1s when the native module is unavailable —
      // skip the check rather than false-positive.
      try {
        const stats = await getMemoryStats();
        if (stats.freeDiskMB >= 0 && stats.freeDiskMB < MIN_FREE_DISK_MB) {
          Alert.alert(
            'Storage almost full',
            `Only ${Math.round(stats.freeDiskMB)}MB free. Free up space to keep recording shots — clips need room for the original and trimmed files.`
          );
          return; // finally resets the eager state flip above
        }
      } catch {}

      // Keep screen awake
      KeepAwake?.activateKeepAwakeAsync('recording');

      const { roundId: rid, holeNumber: hole, shotNumber: shot } = paramsRef.current;

      // Tracer capture (F2/F13): fire compass-heading + device-pitch sampling
      // WITHOUT awaiting — getHeadingAsync needs ~0.5-1s of compass settle and
      // CoreMotion needs a sample window, both of which overlap the multi-
      // second recording instead of delaying it. The local consts are captured
      // by this same closure, which awaits them (with a null timeout) at the
      // save block after recordAsync resolves — no ref needed. Gated so
      // tracer.enabled=false never touches the compass or CoreMotion.
      const captureTracerPose =
        config.tracer.enabled && config.tracer.captureHeading;
      const headingPromise: Promise<{
        headingDeg: number;
        isTrue: boolean;
        calibration: number;
      } | null> =
        captureTracerPose && getHeading
          ? getHeading().catch(() => null)
          : Promise.resolve(null);
      const pitchPromise: Promise<number | null> = captureTracerPose
        ? getDevicePitchDeg().catch(() => null)
        : Promise.resolve(null);

      // Make the iOS audio session record-capable BEFORE recordAsync.
      //
      // PRIMARY FIX (native): a patch-package patch to expo-camera's
      // CameraSessionManager.updateSessionAudioIsMuted() now asserts
      // AVAudioSession .playAndRecord + setActive(true) on the camera's own
      // sessionQueue IMMEDIATELY before it attaches the mic AVCaptureDeviceInput
      // (the exact point where -10868 / kAudioUnitErr_FormatNotSupported fired
      // because react-native-volume-manager held the shared session in the
      // record-hostile .ambient category). That native assertion is the load-
      // bearing fix and is correctly ordered against the capture audio unit —
      // something this JS code could never guarantee on its own. See
      // patches/expo-camera+17.0.10.patch.
      //
      // The block below is now only a defensive belt-and-suspenders for the
      // mid-round re-record case: the CameraView mounts once with a constant
      // mute={false}, so the native just-in-time assertion runs at mount (and on
      // mediaServicesWereReset), NOT on every record. If the user visits the
      // editor between shots, PreviewPlayer flips the shared session to
      // .playback; coming back to record, we re-assert a record-capable session
      // here via expo-av so output/category state is sane before recordAsync.
      // We use expo-av (allowsRecordingIOS:true, MixWithOthers) — the mirror of
      // PreviewPlayer's playback reclaim — rather than RNVM.setCategory, so we
      // do NOT disturb RNVM's active session or its outputVolume KVO (the volume
      // channel that the AB-Shutter3 clicker uses to STOP recording must stay
      // live). This is intentionally NON-fatal: the native patch already
      // guarantees correctness, so any failure here is swallowed.
      try {
        const ExpoAV = require('expo-av') as typeof import('expo-av');
        await ExpoAV.Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          interruptionModeIOS: ExpoAV.InterruptionModeIOS.MixWithOthers,
          shouldDuckAndroid: false,
          interruptionModeAndroid: ExpoAV.InterruptionModeAndroid.DoNotMix,
          playThroughEarpieceAndroid: false,
        });
      } catch (err) {
        console.log('[useCamera] pre-record setAudioMode (non-fatal):', err);
      }

      // Small delay to ensure camera is ready (avoids "error while recording" on iOS)
      await new Promise((r) => setTimeout(r, 200));

      if (!cameraRef.current || !isRecordingRef.current) return;

      // Note: videoQuality must be set as a PROP on <CameraView> (in record.tsx),
      // not passed to recordAsync. It's not a valid recordAsync option.
      const video = await cameraRef.current.recordAsync({
        maxDuration: 120,
      });

      // Force-stopped under the 2s minimum (on-screen button / tutorial
      // end): the recording genuinely ended, but a <2s file can't contain a
      // shot — discard it rather than saving a junk clip.
      if (cancelledGenRef.current === gen) {
        if (video?.uri) {
          deleteFile(video.uri).catch(() => {});
        }
        console.log('[useCamera] cancelled clip discarded (<2s forced stop)');
        return;
      }

      // Practice / tutorial clip — discard it. The user saw the recording
      // happen (REC indicator, torch) but we don't persist anything.
      if (isPractice) {
        if (video?.uri) {
          deleteFile(video.uri).catch(() => {});
        }
        console.log('[useCamera] practice clip discarded (tutorial)');
        return;
      }

      // Recording stopped — process the clip
      if (video?.uri) {
        const finalUri = video.uri;
        const durationSeconds = (Date.now() - recordingStartTime.current) / 1000;

        // Get GPS if available
        let gps: {
          latitude: number;
          longitude: number;
          accuracy?: number | null;
        } | null = null;
        if (getLocation) {
          try {
            // BOUNDED. This await used to be open-ended, so a cold GPS fix
            // could hold the save past FINALIZE_SAFETY_MS — at which point the
            // safety timer cleared isFinalizing, the hole controls unlocked,
            // and the clip landed after the user had already moved holes. GPS
            // is optional metadata; a null fix is far cheaper than that.
            gps = await Promise.race([
              getLocation(),
              new Promise<null>((r) => setTimeout(() => r(null), 4000)),
            ]);
          } catch {
            // GPS optional
          }
        }

        // Tracer capture: the heading/pitch promises were fired at record
        // start, so they're almost always settled by now. Bound the wait at
        // 1500ms each — a compass that never settles becomes a null fix, not
        // a hung save. Nulls are fine: the tracer pipeline gates on them.
        const heading = await Promise.race([
          headingPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 1500)),
        ]);
        const pitchDeg = await Promise.race([
          pitchPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 1500)),
        ]);

        // TEMP tracer-capture diagnostic (remove after field validation):
        // surfaces exactly what the sensors returned for this clip so we can
        // confirm heading/pitch/GPS/accuracy land before going to the course.
        console.log(
          '[TRACER-CAPTURE]',
          JSON.stringify({
            gps: gps ? { lat: gps.latitude, lon: gps.longitude, accM: gps.accuracy ?? null } : null,
            headingDeg: heading?.headingDeg ?? null,
            headingTrue: heading?.isTrue ?? null,
            headingCalibration: heading?.calibration ?? null,
            pitchDownDeg: pitchDeg ?? null,
          })
        );

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
          gps_accuracy_m: gps?.accuracy ?? undefined,
          camera_heading_deg: heading?.headingDeg,
          camera_heading_is_true: heading ? (heading.isTrue ? 1 : 0) : undefined,
          camera_heading_calibration: heading?.calibration,
          camera_pitch_deg: pitchDeg ?? undefined,
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
        // Register the clip as trim-in-flight so the mid-round editor's
        // processAllUntrimmed batch can't start a SECOND detect+trim on the
        // same source file concurrently (the record screen stays mounted
        // under the editor during "Review round so far").
        if (clipId) markTrimInFlight(clipId);
        InteractionManager.runAfterInteractions(() => {
          loadTrimSettings().then(async ({ preRollMs, postRollMs }) => {
          try {
            // Forward the configured detection strategy + options. Live record
            // processes one clip at a time with no inter-clip context ([]).
            const { strategy, optionsJson } = resolveDetection();
            // VISION FIRST, shot-detector as the fallback.
            //
            // swing-vision localizes the swing INSTANT by motion (the club's
            // reversal at the top of the backswing, then the downswing spike
            // ~0.20s later) and decides shot-vs-putt by BODY POSE (peak wrist
            // height in torso lengths) — measured 52/56 on 56 labelled clips.
            // Its result is shaped as a DetectAndTrimResult so every branch
            // below (including onShotClassified for hole auto-advance) is
            // unchanged.
            //
            // visionDetectAndTrim returns null and never throws when the module
            // or model isn't in this build, when the native call rejects, or
            // when the trim produced no file — we then fall through to the
            // unchanged detectAndTrim path.
            const result =
              (await visionDetectAndTrim(finalUri, { preRollMs, postRollMs })) ??
              (await detectAndTrim(
                finalUri,
                preRollMs,
                postRollMs,
                [],
                strategy,
                optionsJson
              ));
            // A/B harness (additive, non-fatal): record a structured row.
            void logDetection(clipId, result).catch(() => {});
            if (!clipId) return;

            // "Delete last shot" may have removed this clip while detection
            // ran. Applying the result would leak a trimmed file for a row
            // that no longer exists, and firing onShotClassified would feed
            // the putt→swing hole-advance detector a shot the user deleted.
            const stillExists = await clipExists(clipId).catch(() => true);
            if (!stillExists) {
              if (result.trimmedUri && result.trimmedUri !== finalUri) {
                deleteFile(result.trimmedUri).catch(() => {});
              }
              console.log('[ShotDetector] clip deleted during detection — skipping classification');
              return;
            }

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
          } finally {
            if (clipId) clearTrimInFlight(clipId);
          }
          });
        });

        const clip: ClipMetadata = {
          // Carry the SQLite rowid so "Delete last shot" can actually delete
          // the row + files for clips recorded THIS session (previously only
          // recovered rounds had ids, so fresh-session undos were memory-only
          // and the clip reappeared in the editor).
          id: clipId,
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
      if (cancelledGenRef.current === gen) {
        // Expected: a <2s forced stop often fails MP4 finalize. The clip
        // was deliberately discarded — don't surface the scary generic
        // error for it.
        console.log('[useCamera] cancelled recording finalize error (expected):', error);
      } else {
        console.error('[useCamera] Recording error:', error);
        // Surface the failure — previously every recordAsync rejection
        // (backgrounding, phone call, disk full, session teardown) was
        // console-only and the user discovered missing shots in the editor.
        if (!isPractice) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          Alert.alert(
            'Recording failed',
            'This shot was not saved. If this keeps happening, check your free storage and avoid locking or leaving the app while recording.'
          );
        }
      }
    } finally {
      // Generation guard: never let a stale invocation's finally clobber a
      // newer recording's state (UI would show idle + KeepAwake would drop
      // while the camera is still recording).
      if (recordingGenRef.current === gen) {
        isRecordingRef.current = false;
        setIsRecording(false);
        isFinalizingRef.current = false;
        setIsFinalizing(false);
        if (finalizeTimeoutRef.current) {
          clearTimeout(finalizeTimeoutRef.current);
          finalizeTimeoutRef.current = undefined;
        }
        KeepAwake?.deactivateKeepAwake('recording');
      }
      // INTENTIONALLY do NOT restore the shared session to .ambient here.
      //
      // The mic AVCaptureDeviceInput stays attached to the AVCaptureSession
      // between shots (mute is a constant false; the input is only removed when
      // mute flips to true). If we flipped the shared session back to .ambient +
      // setActive (which RNVM's setCategory('Ambient', true) does), a subsequent
      // foreground / route-change / interruption could force the still-attached
      // mic input to renegotiate against the record-hostile .ambient category and
      // re-throw -10868 on the running session. Leaving the session in
      // .playAndRecord (asserted natively at mount) is the safe steady state.
      //
      // RNVM's outputVolume KVO — the AB-Shutter3 clicker's volume channel —
      // continues to fire under .playAndRecord, so the clicker still starts and
      // stops recording. When the user navigates to the editor, PreviewPlayer
      // explicitly reclaims a .playback session (expo-av), which is what makes
      // reel previews audible; that reclaim works because we leave
      // expo-camera's automaticallyConfiguresApplicationAudioSession = true.
    }
  }, [getLocation, getHeading, onClipSaved, onShotClassified]);

  const stopRecording = useCallback(async () => {
    if (!isNative || !cameraRef.current || !isRecordingRef.current) return;

    // A stop under the 2s minimum only reaches here when it was FORCED
    // (on-screen record button, tutorial end) — the clicker path swallows
    // early stops in toggleRecording. The recording must genuinely end (the
    // user unambiguously asked), but the too-short file can't contain a
    // shot and often fails MP4 finalize, so mark the generation cancelled:
    // the pipeline discards the file and swallows the expected error.
    const elapsed = Date.now() - recordingStartTime.current;
    if (elapsed < 2000) {
      cancelledGenRef.current = recordingGenRef.current;
    }

    // Eagerly flip the recording state BEFORE telling iOS to finalize the
    // clip. The `recordAsync` promise in startRecording can take 5–10s to
    // resolve on iOS (it has to finalize the MP4 container), and the
    // `finally` block that flips state only runs after that. Without this
    // eager flip:
    //   - The torch (bound to camera.isRecording) stays on for those
    //     5–10s after the user pressed stop, looking like a bug.
    //   - The shutter onPress closure still sees isRecording=true, so a
    //     follow-up press fires "instant stop" against an already-stopped
    //     recording — calling cameraRef.stopRecording() twice can confuse
    //     the iOS AVCaptureSession and stretch the finalize delay further.
    // The recordAsync promise still resolves in the background and the
    // clip is still saved through the existing finally pipeline; this
    // just makes the UI source of truth instant.
    isRecordingRef.current = false;
    setIsRecording(false);

    // Enter the finalizing window: block new starts until the recordAsync
    // pipeline settles (its finally clears this). A safety timeout unblocks
    // the button if the promise somehow never settles.
    isFinalizingRef.current = true;
    setIsFinalizing(true);
    const gen = recordingGenRef.current;
    if (finalizeTimeoutRef.current) clearTimeout(finalizeTimeoutRef.current);
    finalizeTimeoutRef.current = setTimeout(() => {
      if (recordingGenRef.current === gen && isFinalizingRef.current) {
        console.log('[useCamera] finalize safety timeout — unblocking record');
        isFinalizingRef.current = false;
        setIsFinalizing(false);
      }
    }, FINALIZE_SAFETY_MS);

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      cameraRef.current.stopRecording();
      // The recordAsync promise in startRecording will resolve with the video
    } catch (error) {
      console.error('[useCamera] Stop recording error:', error);
    }
  }, []);

  const toggleRecording = useCallback(async (opts?: { force?: boolean }) => {
    // Debounce — ignore rapid double-fires from shutter (volume + key event).
    // 200ms is enough to swallow the doubled event without making a genuine
    // "start, wait ~300ms, try stop" interaction feel unresponsive.
    const now = Date.now();
    if (now - lastToggleTime.current < 200) return;
    lastToggleTime.current = now;

    if (isRecordingRef.current) {
      // Minimum-duration gate (pure logic in lib/liveRecordingLogic): no
      // real golf clip is under ~2s, but phantom volume events DO arrive
      // ~1-1.5s after start (clicker bounce / iOS volume-ramp echo), so an
      // un-forced early stop is swallowed. A FORCED early stop (on-screen
      // record button — an unambiguous user intent) cancels instead: the
      // recording ends and the too-short clip is discarded, rather than
      // silently running on to the 120s cap after a confirming haptic.
      const action = resolveStopRequest({
        elapsedMs: now - recordingStartTime.current,
        forced: opts?.force ?? false,
      });
      if (action === 'ignore') {
        console.log(
          `[useCamera] stop ignored — only ${now - recordingStartTime.current}ms after start (phantom click guard)`
        );
        return;
      }
      // 'cancel' semantics are applied inside stopRecording (it marks the
      // generation cancelled so the pipeline discards the clip).
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [startRecording, stopRecording]);

  // Stop gracefully BEFORE iOS tears down the capture session on
  // background/lock/phone-call. expo-camera stops the whole session when the
  // app backgrounds, which aborts the in-flight recordAsync with the generic
  // recording error and loses the footage entirely; stopping on the
  // 'inactive' transition instead lets the MP4 finalize and the clip save
  // through the normal pipeline.
  useEffect(() => {
    if (!isNative) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && isRecordingRef.current) {
        console.log('[useCamera] app leaving foreground mid-recording — stopping to salvage clip');
        stopRecording();
      }
    });
    return () => sub.remove();
  }, [stopRecording]);

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
    isFinalizing,
    hasPermission,
    requestPermission,
    startRecording,
    stopRecording,
    toggleRecording,
    simulateRecording,
  };
}
