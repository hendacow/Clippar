import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Text, Pressable, Alert, Platform, StyleSheet, ScrollView, Linking } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useRecordingContext } from '@/contexts/RecordingContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Bluetooth,
  BluetoothOff,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  Flag,
  Film,
  Video,
  ArrowLeft,
  Settings2,
  SwitchCamera,
  Smartphone,
  X,
} from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { RecordingIndicator } from '@/components/record/RecordingIndicator';
import { ScoreOverlay } from '@/components/record/ScoreOverlay';
import { PenaltySheet } from '@/components/record/PenaltySheet';
import { CameraPermissionScreen } from '@/components/record/CameraPermissionScreen';
import { CourseSearch } from '@/components/record/CourseSearch';
import { RecentScorecards } from '@/components/record/RecentScorecards';
import { ScorecardSetupScreen } from '@/components/record/ScorecardSetupScreen';
import { ClickerTutorial } from '@/components/record/ClickerTutorial';
import { RecordingSettingsSheet } from '@/components/record/RecordingSettingsSheet';
import { useShutter } from '@/hooks/useShutter';
import { useRound } from '@/hooks/useRound';
import { useCamera } from '@/hooks/useCamera';
import { useLocation } from '@/hooks/useLocation';
import { getOrphanedRounds, getCloudBackupEnabled, getSetting, setSetting } from '@/lib/storage';
import { getMountCardDismissed, dismissMountCard } from '@/lib/mountOffer';
import { getOnboardingProfile } from '@/lib/onboardingProfile';
import { enqueueRoundUpload } from '@/lib/uploadQueue';
import { listCoursePresets, touchCoursePreset, upsertCoursePreset } from '@/lib/api';
import { findPresetToUpdate } from '@/lib/scorecardLogic';
import {
  startHoleOptions,
  normalizeStartHole,
  startRoundGate,
  isCourseKnownForAnyStart,
  findSavedScorecard,
  resolveRoundHoles,
  recentSetups,
} from '@/lib/roundSetup';
import { isCaptureArmed } from '@/lib/captureArming';
import { useOnboardingTarget } from '@/hooks/useOnboardingTarget';
import type { PenaltyType, ClipMetadata, HoleData } from '@/types/round';
import type { CoursePreset } from '@/types/preset';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const DEFAULT_PAR = 4;

// The tab bar is a floating pill absolutely positioned over the screen
// (app/(tabs)/_layout.tsx: PILL_HEIGHT 68 sitting on max(insets.bottom, 8)),
// so every setup screen underneath has to reserve that space itself. It
// didn't: Start Round and the holes selector sat behind the pill on device.
// TAB_BAR_CLEARANCE is what the pill takes ABOVE the safe-area inset, for
// callers that already pad for the inset themselves.
const TAB_BAR_CLEARANCE = 68 + 16;
const tabBarClearance = (bottomInset: number) =>
  TAB_BAR_CLEARANCE + Math.max(bottomInset, 8);

// Conditionally import CameraView for native
const CameraView = isNative
  ? (require('expo-camera') as typeof import('expo-camera')).CameraView
  : null;

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  // NOTE: there is deliberately no `useBLE()` here. It used to sit on this
  // line, was never read (the screen uses `shutter.*` throughout), and each
  // instance allocated a CBCentralManager — which is what raises the iOS
  // Bluetooth prompt. expo-router eagerly requires every file under app/, so
  // that dead call ran at cold start, before login, with no context on screen
  // (spec 5.7 BLE permission overreach). useShutter owns the one BLE handle
  // this screen needs.
  const round = useRound();
  const {
    getCurrentLocation,
    getCurrentHeading,
    requestPermission: requestLocationPermission,
  } = useLocation();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[] | undefined>();
  const [showPenalty, setShowPenalty] = useState(false);
  const [orphanedRound, setOrphanedRound] = useState<{ id: string; course_name: string } | null>(null);
  const importTarget = useOnboardingTarget('import-card');

  // Clippar Mount cross-sell card (feat/mount-upsell). Lives on the idle
  // chooser only — never anywhere near the live camera UI. Hidden until the
  // persisted dismiss flag loads (starts false) so it can't flash for users
  // who already closed it.
  const [mountCardVisible, setMountCardVisible] = useState(false);

  // Wave 3 mode chooser. The Record tab now shows two cards on entry —
  // Import (clips from Photos) and Live (BLE-triggered camera recording).
  // null = chooser visible; 'live' = course picker + camera flow visible.
  // The Import path uses router.push to /round/import and never sets
  // this to 'import' (no need — that flow lives on a different route).
  const [mode, setMode] = useState<null | 'live'>(null);

  // The Live setup is a three-step flow:
  //   - 'setup'      = recent courses + course search + 9/18. The hub.
  //   - 'start-hole' = "which hole are you starting on", reached BOTH from
  //                    the 9/18 selector and from tapping a recent course,
  //                    so the tee-off hole is always confirmed before a
  //                    round begins (golfers shotgun-start off 10).
  //   - 'scorecard'  = the per-hole par entry screen ("Set the scorecard"),
  //                    reached from either of the above. Saving there
  //                    creates a bookmark preset carrying hole_pars.
  //
  // A full-screen preset picker used to sit in front of 'setup'. It was
  // effectively unreachable — the presets fetch below starts when Live opens,
  // so the `presets.length > 0` test that chose it always ran against an
  // empty list on first entry — and the golfer never saw the scorecards they'd
  // saved. The recents row on 'setup' replaces it. (PresetPickerScreen itself
  // is still the Import flow's picker.)
  const [livePhase, setLivePhase] = useState<'setup' | 'start-hole' | 'scorecard'>('setup');
  // True while a "Save course scorecard" write is in flight (disables the CTA).
  const [savingScorecard, setSavingScorecard] = useState(false);

  // Wave 3 Phase C: round setup. Defaults match the legacy hard-coded
  // behaviour (full 18 from hole 1). When a preset is tapped these get
  // overwritten with its values; the manual flow uses the segmented
  // controls below the course search to set them.
  const [holesPlayed, setHolesPlayed] = useState<9 | 18>(18);
  const [startHole, setStartHole] = useState<1 | 10>(1);
  const [presets, setPresets] = useState<CoursePreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);

  // Recording-screen options (Wave 3 batch).
  //   - lightEnabled: master switch for the torch-while-recording indicator.
  //   - showRecordingSettings: the gear-button bottom sheet.
  //   - tutorialActive: the gated clicker tutorial overlay is up. While true,
  //     the real shutter handlers are suppressed so practising gestures
  //     doesn't actually record / advance holes.
  //   - tutorialDismissed: user chose "don't show again" (loaded from + saved
  //     to SQLite settings). Gates the auto-show on round start.
  //   - dontShowAgain: the in-tutorial checkbox state.
  const [lightEnabled, setLightEnabled] = useState(true);
  const [showRecordingSettings, setShowRecordingSettings] = useState(false);
  const [tutorialActive, setTutorialActive] = useState(false);
  // Two-phase tutorial. 'intro' is a BLOCKING choice card — nothing underneath
  // it is pressable, so the user can't unknowingly play a real hole while the
  // camera is in practice mode. Only after they choose "Practise" do we enter
  // 'coaching', where the card goes non-blocking and clips are discarded on
  // purpose. This is what previously ate real shots: the coach auto-appeared
  // over a live round, every clip recorded under it was silently thrown away,
  // and dismissing it wiped the round back to the start hole.
  const [tutorialPhase, setTutorialPhase] = useState<'intro' | 'coaching'>('intro');
  const [tutorialDismissed, setTutorialDismissed] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  // Monotonic penalty counter — bumped each time a penalty is applied so the
  // tutorial coach can detect "a penalty happened" (state alone can't tell a
  // penalty from a recorded shot, since both touch currentShot).
  const [penaltyCount, setPenaltyCount] = useState(0);
  // Ensures the tutorial auto-shows at most once per round (not on every
  // re-render where isActive stays true).
  const tutorialShownForRoundRef = useRef<string | null>(null);

  // ── Camera framing controls (ADDITIVE — does NOT touch analytics) ──────
  // Lens (zoom) and facing are pure capture-side choices: the shot detector,
  // auto-trim, and shot classification all run AFTER capture, on the recorded
  // file (useCamera → detectAndTrim), so changing the lens or flipping the
  // camera never reaches the detection/post-track pipeline.
  //
  // Why we set `selectedLens` explicitly: with it unset, expo-camera on iOS
  // falls back to the virtual multi-camera device at minimum zoom, which on
  // multi-lens iPhones is the 0.5× ultra-wide. Pinning the wide-angle (1×)
  // lens makes 1× the default; the toggle swaps to ultra-wide for 0.5×.
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [availableLenses, setAvailableLenses] = useState<string[]>([]);
  const [zoomMode, setZoomMode] = useState<'0.5x' | '1x'>('1x');

  // ── Continuous pinch-to-zoom (ADDITIVE — capture-side only) ────────────
  // Digital zoom applied ON TOP of the selected lens. expo-camera's `zoom`
  // prop is a normalized 0..1 value (0 = the lens's native framing, 1 = its
  // max digital zoom); we drive it from a two-finger Pinch gesture over the
  // preview. Like the lens toggle above, this is a pure capture choice — the
  // shot detector / auto-trim run on the recorded file afterwards, so zoom
  // never reaches the detection pipeline. Unlike the lens/flip toggles it is
  // NOT blocked mid-recording: setting videoZoomFactor is a digital crop that
  // doesn't reconfigure the AVCaptureSession (safe to ramp while recording,
  // exactly like the native Camera app).
  //
  // `zoom` is the React state passed to CameraView. `zoomShared` mirrors it on
  // the UI thread so the gesture worklet can read the live value on begin, and
  // `pinchBaseZoom` snapshots the zoom at gesture start so scaling is relative.
  const [zoom, setZoom] = useState(0);
  const [zoomIndicatorVisible, setZoomIndicatorVisible] = useState(false);
  const zoomShared = useSharedValue(0);
  const pinchBaseZoom = useSharedValue(0);
  const lastAppliedZoom = useSharedValue(0);
  const zoomIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pinch feel. (scale - 1) is the fractional finger spread; multiplying by
  // SENSITIVITY spreads a full pinch across roughly the whole 0..1 range while
  // keeping small movements fine-grained. iOS maps the normalized 0..1 zoom
  // non-linearly onto videoZoomFactor (the low end is already compressed), so
  // low-zoom control stays precise like the native camera. Tune on device.
  const PINCH_SENSITIVITY = 0.5;
  // Approximate perceived digital-zoom range for the on-screen indicator only
  // (NOT an exact optical figure — see zoomLabel below).
  const MAX_DIGITAL_ZOOM_X = 5;

  // Resolve the iOS lens names (localized strings from getAvailableLensesAsync,
  // e.g. "Back Camera", "Back Ultra Wide Camera") to our two framings.
  const ultraWideLens = availableLenses.find((l) => /ultra/i.test(l));
  const wideLens =
    availableLenses.find((l) => /^(back|front) camera$/i.test(l)) ??
    availableLenses.find((l) => !/(ultra|tele|dual|triple)/i.test(l)) ??
    availableLenses[0];
  // 0.5× only offered when the current camera actually has an ultra-wide lens
  // (front cameras don't), so the toggle hides itself after a flip to front.
  const hasUltraWide = !!ultraWideLens;
  const selectedLens =
    zoomMode === '0.5x' && ultraWideLens ? ultraWideLens : wideLens;

  const { setRecordingActive } = useRecordingContext();
  const roundState = round.state;
  const isActive = roundState?.status === 'in_progress';
  // Screen focus. "Review round so far" router.pushes the editor on TOP of
  // this screen (deliberately, so the in-memory round survives), which means
  // isActive alone stays true while the user is in the editor — the shutter
  // subscriptions below must ALSO be focus-gated or volume presses in the
  // editor (adjusting preview playback volume) start recordings / advance
  // holes behind the user's back.
  const isFocused = useIsFocused();

  // Is this screen an ARMED capture surface for shutter input right now?
  // (lib/captureArming — pure, tested in tests/captureArming.test.ts.)
  //
  // The clicker is an unauthenticated HID keyboard, so "the UI is blocked" is
  // never a control: the tutorial intro card's scrim swallows touches, but a
  // VolumeUp/Enter event from the clicker (or any other paired keyboard in
  // range) walks straight past it. Under that card `practice` is still false,
  // so the clip is REAL — and the practice pass that follows ends in
  // resetToStart, which unlinks the file from disk with no undo entry. Both
  // shutter subscriptions below gate on this instead of on isActive/isFocused
  // alone (spec 5.7, control BLE-001).
  const captureArmed = isCaptureArmed({
    roundInProgress: isActive,
    screenFocused: isFocused,
    tutorialActive,
    tutorialPhase,
  });

  // Declared HERE, below captureArmed, rather than at the top of the component
  // — the `armed` option needs that value and hooks cannot read a binding
  // declared after them. Nothing between the old position and here touched
  // `shutter`, so the move is inert.
  //
  // Passing `armed` matters: the subscriptions below already gate on
  // captureArmed, but useShutter ALSO suppresses the iOS volume HUD and pins
  // system volume to 0.5 so the hardware buttons read as shutter presses. That
  // is a global, app-wide side effect, and it used to outlive the capture
  // surface — visit Record once and every volume press for the rest of the
  // session was swallowed, including while the user was watching their own reel
  // with music. The option defaults to true, so leaving it unpassed silently
  // kept the old behaviour: a gate that exists and is never applied.
  const shutter = useShutter({ armed: captureArmed });

  // Camera hook — only active when round is in progress
  const camera = useCamera({
    roundId: roundState?.roundId ?? '',
    holeNumber: roundState?.currentHole ?? 1,
    shotNumber: roundState?.currentShot ?? 1,
    // Tracer capture: tight GPS (BestForNavigation) only when the tracer is
    // enabled — landing-spot pairing gates on the accuracy radius. Disabled
    // (day zero) this closure is byte-identical to the old Accuracy.High call.
    getLocation: useCallback(
      () => getCurrentLocation({ highAccuracy: config.tracer.enabled }),
      [getCurrentLocation]
    ),
    // Compass azimuth at record start (non-prompting; null unless location
    // permission already granted). useCamera only fires it when
    // config.tracer.enabled && config.tracer.captureHeading.
    getHeading: getCurrentHeading,
    // Practice mode ONLY during the coaching phase the user explicitly opted
    // into. During 'intro' the card blocks every control, so nothing can be
    // recorded — and once the tutorial is gone, clips are real again.
    practice: tutorialActive && tutorialPhase === 'coaching',
    onClipSaved: useCallback(
      (clip: ClipMetadata) => {
        round.recordClip(clip);
      },
      [round.recordClip]
    ),
    onShotClassified: useCallback(
      (shotType: import('shot-detector').ShotTypeClassification) => {
        round.onShotClassified(shotType);
      },
      [round.onShotClassified]
    ),
  });

  // Recording OR finalizing (the 5-10s MP4 write + save after a stop).
  // Round-mutating actions (End Round / Next Hole / pickup / delete last
  // shot / review) must wait for both: acting mid-recording unmounts the
  // CameraView under an active recordAsync (killing the clip with the
  // generic recording error), and acting mid-finalize scores or deletes
  // around a clip that hasn't landed in round state yet.
  const recordingBusy = camera.isRecording || camera.isFinalizing;

  // Camera framing handlers — defined after `camera` so they can read
  // isRecording. Both are inert mid-clip so the AVCaptureSession is never
  // reconfigured under a running recording.
  // Reset digital pinch zoom back to the lens's native framing. Called when
  // the base lens changes (flip / 0.5×–1× toggle) so pinch zoom never silently
  // compounds on top of a lens the user just switched to — they always start
  // fresh at the new framing, matching the native camera.
  const resetPinchZoom = useCallback(() => {
    zoomShared.value = 0;
    lastAppliedZoom.value = 0;
    setZoom(0);
  }, [zoomShared, lastAppliedZoom]);

  const flipCamera = useCallback(() => {
    if (camera.isRecording) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
    setZoomMode('1x'); // front has no ultra-wide — always land on 1×
    resetPinchZoom();
  }, [camera.isRecording, resetPinchZoom]);

  const selectZoom = useCallback(
    (mode: '0.5x' | '1x') => {
      if (camera.isRecording) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setZoomMode(mode);
      resetPinchZoom();
    },
    [camera.isRecording, resetPinchZoom]
  );

  // Zoom indicator show/hide. The pill is visible while pinching and lingers
  // ~0.9s after the fingers lift (like the native camera), then fades out.
  const showZoomIndicator = useCallback(() => {
    if (zoomIndicatorTimer.current) {
      clearTimeout(zoomIndicatorTimer.current);
      zoomIndicatorTimer.current = null;
    }
    setZoomIndicatorVisible(true);
  }, []);

  const scheduleHideZoomIndicator = useCallback(() => {
    if (zoomIndicatorTimer.current) clearTimeout(zoomIndicatorTimer.current);
    zoomIndicatorTimer.current = setTimeout(() => {
      setZoomIndicatorVisible(false);
      zoomIndicatorTimer.current = null;
    }, 900);
  }, []);

  useEffect(
    () => () => {
      if (zoomIndicatorTimer.current) clearTimeout(zoomIndicatorTimer.current);
    },
    []
  );

  // Two-finger continuous pinch → digital zoom. The gesture callbacks run as
  // Reanimated worklets on the UI thread for 60fps smoothness; we only hop to
  // JS (runOnJS → setZoom) when the value moves by a meaningful step so the
  // CameraView prop re-renders without flooding the JS thread each frame.
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchBaseZoom.value = zoomShared.value;
          lastAppliedZoom.value = zoomShared.value;
          runOnJS(showZoomIndicator)();
        })
        .onUpdate((e) => {
          const next = Math.min(
            1,
            Math.max(0, pinchBaseZoom.value + (e.scale - 1) * PINCH_SENSITIVITY)
          );
          zoomShared.value = next;
          if (Math.abs(next - lastAppliedZoom.value) >= 0.004 || next === 0 || next === 1) {
            lastAppliedZoom.value = next;
            runOnJS(setZoom)(next);
          }
        })
        .onFinalize(() => {
          runOnJS(setZoom)(zoomShared.value);
          runOnJS(scheduleHideZoomIndicator)();
        }),
    [
      pinchBaseZoom,
      zoomShared,
      lastAppliedZoom,
      showZoomIndicator,
      scheduleHideZoomIndicator,
    ]
  );

  // Human-readable zoom label for the indicator. Combines the base lens
  // framing (0.5× ultra-wide vs 1× wide) with the digital multiplier. This is
  // an APPROXIMATION for UX only — not an exact optical focal length.
  const baseLensX = zoomMode === '0.5x' && hasUltraWide ? 0.5 : 1;
  const zoomLabel = `${(baseLensX * (1 + zoom * (MAX_DIGITAL_ZOOM_X - 1))).toFixed(1)}x`;

  // TEMP camera-lens diagnostic (dev only — remove after field validation).
  // Prints exactly what this device reports so the 1×/0.5× lens matching can
  // be tuned to the real localized lens names (they're device-specific).
  useEffect(() => {
    if (__DEV__ && availableLenses.length) {
      console.log(
        '[camera-lenses]',
        JSON.stringify({
          lenses: availableLenses,
          wide: wideLens,
          ultra: ultraWideLens,
          selected: selectedLens,
          facing,
          zoom: zoomMode,
        })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableLenses, facing, zoomMode]);

  // Hide tab bar during active recording
  useEffect(() => {
    setRecordingActive(isActive);
    return () => { setRecordingActive(false); };
  }, [isActive, setRecordingActive]);

  // Onboarding personalization: prefill the course field with the home
  // course from onboarding (visible "it used my answer" proof). Text-only —
  // the user still picks from the dropdown to attach hole data, and any
  // value they've already typed wins.
  useEffect(() => {
    getOnboardingProfile()
      .then((p) => {
        if (p.homeCourseName) {
          setCourseName((cur) => (cur.trim() ? cur : p.homeCourseName!));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe shutter press → 1/2/3-click action map.
  //
  // The cheap off-the-shelf shutters Clippar supports only emit a single
  // event per physical press (no key-up/key-down), so the only gesture
  // dimensions we get are click count and rhythm. useShutter.onClick
  // gives us debounced count semantics:
  //   1 click  = toggle shot recording (start a new clip, or stop the
  //              current one)
  //   2 clicks = next hole — user can advance without touching the phone
  //   3 clicks = quick penalty (defaults to water hazard, the most
  //              common type; tap the on-screen penalty sheet to choose
  //              a different type)
  //
  // The cost is a CLICK_WINDOW_MS (~1000ms) delay on single-click actions
  // because we have to wait to see whether more clicks are coming. For
  // golf this is invisible — pressing to start a shot is followed by
  // 5–20s of walking up to the ball anyway.
  //
  // EXCEPTION: while a clip is recording, double/triple clicks are no-op
  // (end-hole / penalty only make sense between shots). So there's
  // nothing to wait for — we stop on the very first press via onPress
  // below, and use clearPendingClicks() to prevent the same press from
  // re-triggering a "toggle" 1s later through this onClick path.
  useEffect(() => {
    if (!captureArmed) return;

    const unsubscribe = shutter.onClick(({ count }) => {
      console.log(`[record] onClick count=${count} isRecording=${camera.isRecording} ts=${Date.now() % 100000}`);
      // During the tutorial's COACHING phase the real actions DO fire — that
      // phase is a live practice run the user opted into (camera is in
      // practice mode so clips are discarded, and round.resetToStart wipes
      // everything when it ends). The INTRO card is the opposite: it is a
      // blocking scrim the user has not answered yet, so captureArmed is
      // false above and this handler is not even subscribed.

      // count===1 while recording would mean the onPress fast-path failed
      // to short-circuit (e.g. clearPendingClicks didn't run). Log so we
      // catch regressions, then bail — onPress already toggled.
      if (camera.isRecording) {
        console.log('[record] onClick fired while recording — IGNORED (onPress should have handled)');
        return;
      }
      // While the previous clip finalizes (5-10s MP4 write + save), a start
      // would be silently dropped by useCamera and an end-hole would score
      // the in-flight clip into the wrong hole — swallow the gesture.
      if (camera.isFinalizing) {
        console.log('[record] onClick fired while finalizing — IGNORED');
        return;
      }
      if (count === 1) {
        console.log('[record] action: toggleRecording (start)');
        if (isNative) {
          camera.toggleRecording();
        } else {
          camera.simulateRecording();
        }
      } else if (count === 2) {
        console.log('[record] action: endHole');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        round.endHole();
      } else if (count === 3) {
        console.log('[record] action: addPenalty water_hazard');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        round.addPenalty('water_hazard');
        // Bump the penalty counter so the tutorial coach can detect that a
        // penalty was applied (state alone is ambiguous vs. a recorded shot).
        setPenaltyCount((n) => n + 1);
      }
    });

    return unsubscribe;
  }, [
    shutter.onClick,
    captureArmed,
    camera.toggleRecording,
    camera.simulateRecording,
    camera.isRecording,
    camera.isFinalizing,
    round.endHole,
    round.addPenalty,
  ]);

  // Arm the shutter pipeline for THIS screen when it becomes both active
  // and focused:
  //  - clearPendingClicks: a press buffered on the setup screen (e.g. the
  //    user test-clicking their clicker) must not flush into the freshly
  //    subscribed onClick handler and phantom-start a recording on entry;
  //  - armVolumeGrace: the CameraView mounting at round start natively
  //    asserts .playAndRecord + setActive, and iOS emits a volume
  //    notification on that activation. The mount-time grace window has
  //    long expired by then (round setup takes >1.5s), so re-arm it here.
  //    Same on refocus from the editor, whose PreviewPlayer flips the
  //    shared audio session and emits the same class of noise.
  //    Gated on captureArmed (not isActive/isFocused) so that dismissing the
  //    blocking tutorial intro card also drains any presses that landed while
  //    it was up — otherwise a press made under the card would flush into the
  //    handler the instant it subscribes and start a clip the user never asked
  //    for, which is the same bug one step later.
  useEffect(() => {
    if (!captureArmed) return;
    shutter.clearPendingClicks();
    shutter.armVolumeGrace();
  }, [captureArmed, shutter.clearPendingClicks, shutter.armVolumeGrace]);

  // Immediate-press handler. Two jobs:
  //   1. ALWAYS: light haptic so the user feels the press registered, even
  //      though the gesture-resolution path is debounced by ~1s.
  //   2. WHILE RECORDING: stop the clip instantly. We don't need to wait
  //      for potential double/triple because those are no-ops mid-clip
  //      anyway. We also call clearPendingClicks() so the same press
  //      doesn't trigger an onClick 1s later that would start a NEW
  //      recording.
  useEffect(() => {
    // Same arming gate as the onClick path above — a press under the blocking
    // intro card must not reach the camera at all, in either channel.
    if (!captureArmed) return;
    return shutter.onPress(() => {
      if (camera.isRecording) {
        console.log('[record] onPress: instant stop (was recording)');
        shutter.clearPendingClicks();
        // No stop-confirm haptic here: toggleRecording swallows stops that
        // arrive <2s after start (phantom clicker-bounce guard), and firing
        // Medium before knowing would tell the user "stopped" while the
        // camera keeps recording to the 120s cap. stopRecording fires the
        // Medium impact itself when a stop actually happens.
        if (isNative) {
          camera.toggleRecording();
        } else {
          camera.simulateRecording();
        }
      } else {
        Haptics.selectionAsync();
      }
    });
  }, [
    shutter.onPress,
    shutter.clearPendingClicks,
    captureArmed,
    camera.isRecording,
    camera.toggleRecording,
    camera.simulateRecording,
  ]);

  // Check for orphaned rounds on mount
  useEffect(() => {
    if (roundState) return;
    getOrphanedRounds().then((orphans) => {
      if (orphans.length > 0) {
        setOrphanedRound(orphans[0]);
      }
    });
  }, [roundState]);

  // Load the "don't show clicker tutorial again" flag once on mount.
  useEffect(() => {
    getSetting('clicker_tutorial_dismissed')
      .then((v) => setTutorialDismissed(v === '1'))
      .catch(() => {});
  }, []);

  // Load the mount-card dismiss flag once on mount.
  useEffect(() => {
    getMountCardDismissed()
      .then((dismissed) => setMountCardVisible(!dismissed))
      .catch(() => {});
  }, []);

  // X on the mount card: hide now, persist so it stays gone.
  const handleDismissMountCard = useCallback(() => {
    Haptics.selectionAsync();
    setMountCardVisible(false);
    void dismissMountCard();
  }, []);

  // Auto-show the clicker tutorial when a Live round becomes active, unless
  // the user has dismissed it. Guarded by a ref so it fires once per round,
  // not on every render where isActive stays true. The tutorial is a live
  // practice run on this round — round.resetToStart wipes it clean when done.
  useEffect(() => {
    if (!isActive || !roundState) return;
    if (tutorialDismissed) return;
    if (tutorialShownForRoundRef.current === roundState.roundId) return;
    tutorialShownForRoundRef.current = roundState.roundId;
    setDontShowAgain(false);
    setPenaltyCount(0);
    // Always open on the blocking intro card, never straight into practice.
    setTutorialPhase('intro');
    setTutorialActive(true);
  }, [isActive, roundState, tutorialDismissed]);

  // User chose "Practise first" on the intro card — now (and only now) does
  // the round go into practice mode.
  const startTutorialPractice = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPenaltyCount(0);
    setTutorialPhase('coaching');
  }, []);

  // End the tutorial (finished OR skipped): stop any practice recording,
  // wipe the round back to a clean slate, persist the dismiss flag, and
  // clear the overlay. Practice clips are discarded by the camera, and
  // resetToStart clears any hole/penalty changes made while practising.
  const endTutorial = useCallback(async () => {
    if (dontShowAgain) {
      setTutorialDismissed(true);
      void setSetting('clicker_tutorial_dismissed', '1');
    }
    const wasPractising = tutorialPhase === 'coaching';
    setTutorialActive(false);
    setTutorialPhase('intro');
    if (camera.isRecording) {
      if (isNative) camera.stopRecording();
      else camera.simulateRecording();
    }
    // Only wipe the round if a practice pass actually ran. Declining the intro
    // card must never touch the round — this reset used to fire unconditionally
    // and cleared real shots + snapped the hole pointer back to the start hole.
    if (wasPractising) {
      await round.resetToStart();
    }
    setPenaltyCount(0);
  }, [
    dontShowAgain,
    tutorialPhase,
    camera.isRecording,
    camera.stopRecording,
    camera.simulateRecording,
    round.resetToStart,
  ]);

  // Replay from the recording settings sheet. Because replaying runs another
  // practice pass that ends in resetToStart, doing it after real shots would
  // wipe them — so confirm first when the round already has progress.
  const handleReplayTutorial = useCallback(() => {
    setShowRecordingSettings(false);
    const begin = () => {
      setDontShowAgain(false);
      setPenaltyCount(0);
      setTutorialPhase('intro');
      setTutorialActive(true);
    };
    const hasProgress =
      !!roundState &&
      (roundState.clips.length > 0 ||
        roundState.currentShot > 1 ||
        roundState.currentHole !== roundState.startHole);
    if (hasProgress) {
      Alert.alert(
        'Replay tutorial?',
        'This runs another practice pass and resets your round to the start — shots taken so far will be cleared.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replay & reset', style: 'destructive', onPress: begin },
        ]
      );
    } else {
      begin();
    }
  }, [roundState]);

  // Open the scorecard/editor to review the round in progress. Guarded so
  // we don't navigate away mid-recording. The record screen stays mounted
  // underneath (router.push), so the in-memory round survives the trip.
  const handleReviewRound = useCallback(() => {
    if (!roundState) return;
    if (recordingBusy) {
      Alert.alert('Stop recording first', 'Stop the current clip and let it finish saving before reviewing your round.');
      return;
    }
    setShowRecordingSettings(false);
    router.push(`/round/editor?roundId=${roundState.roundId}&review=1`);
  }, [roundState, recordingBusy]);

  // Delete the most recent clip on the current hole. Blocked while a clip
  // is recording or still saving: the just-stopped clip only enters round
  // state when its save pipeline completes (5-10s), so an immediate delete
  // would target the PREVIOUS clip on the hole — permanently destroying a
  // good shot while keeping the one the user meant to remove.
  const handleDeleteLastShot = useCallback(() => {
    if (recordingBusy) {
      Alert.alert(
        'Clip still saving',
        'Wait a few seconds for the last clip to finish saving, then delete it.'
      );
      return;
    }
    const hole = roundState?.currentHole;
    Alert.alert(
      `Delete last shot on hole ${hole}`,
      `Remove hole ${hole}'s most recent clip? You can restore it from this menu afterwards.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const removed = await round.deleteLastClip();
            setShowRecordingSettings(false);
            if (!removed) {
              Alert.alert('Nothing to delete', `No clips recorded on hole ${hole} yet.`);
            }
          },
        },
      ]
    );
  }, [round.deleteLastClip, recordingBusy, roundState?.currentHole]);

  // Put back the most recently deleted shot. Safe to run at any time — the
  // clip returns to the hole it was recorded on, not the hole you're on now.
  const handleUndoDelete = useCallback(async () => {
    const hole = await round.undoDeleteClip();
    setShowRecordingSettings(false);
    if (hole === null) {
      Alert.alert('Nothing to restore', 'No deleted shots from this round.');
    }
  }, [round.undoDeleteClip]);

  // Whether the current hole has any clips to delete.
  const canDeleteLastShot = !!roundState?.clips.some(
    (c) => c.holeNumber === roundState.currentHole
  );

  const currentPar = roundState?.courseHoles
    ? (roundState.courseHoles.find((h) => h.holeNumber === roundState.currentHole)?.par ?? DEFAULT_PAR)
    : DEFAULT_PAR;

  // Ask for the capture permissions HERE — at the moment the user commits to
  // Live capture — and nowhere earlier.
  //
  // useCamera used to fire the camera + microphone prompts from its mount
  // effect, and RecordScreen calls useCamera unconditionally, above the mode
  // chooser. So a fresh install got two system dialogs the instant the Record
  // tab was tapped, before "How are you capturing this round?" was even
  // readable — including for users who only ever wanted Import (which uses
  // MediaLibrary, not the camera). Spec 5.6: ask at the moment the user starts
  // the capture feature. An out-of-context prompt is also a sticky denial: iOS
  // never asks twice, and a denial parks the user on CameraPermissionScreen.
  //
  // Location is requested here too, and deliberately BEFORE the round starts:
  // useLocation's fix makes getCurrentLocation non-prompting, so this is the
  // one place a location dialog can appear. Previously the first clip save of
  // a session raised it — over the live camera, mid-round, triggered by a
  // clicker press (spec 6.5: a clicker event must not raise a permission
  // dialog). GPS is optional metadata, so a denial never blocks the round.
  const requestCapturePermissions = useCallback(async () => {
    if (!isNative) return;
    await camera.requestPermission();
    // Non-blocking: no fix simply means clips carry no coordinates.
    await requestLocationPermission().catch(() => false);
  }, [camera.requestPermission, requestLocationPermission]);

  // One description of the round being set up. The Start Round gate, the
  // start-hole step and the round start itself all read it, so they can't
  // disagree about which course/holes we're talking about.
  const setup = useMemo(
    () => ({
      courseName,
      courseId: selectedCourseId,
      courseHoles,
      presets,
      holesPlayed,
      startHole,
    }),
    [courseName, selectedCourseId, courseHoles, presets, holesPlayed, startHole],
  );
  const gate = startRoundGate(setup);

  // Start the round from whatever the setup state currently says. Both paths
  // into 'start-hole' (9/18 selector, recent course) end here.
  //
  // The gate is the point: on a course we have no pars for, every hole would
  // be stamped DEFAULT_PAR and that invented scorecard gets burned into the
  // exported reel, which the golfer can't re-record. A course we already hold
  // hole data for is NOT gated — see lib/roundSetup.
  const startRound = async () => {
    if (!gate.allowed) {
      Alert.alert(
        gate.reason === 'no-course' ? 'Course name' : 'Set the scorecard first',
        gate.reason === 'no-course'
          ? 'Please enter or select a course to start.'
          : "We don't have this course's pars, so the scorecard on your reel would be guesswork. Set the scorecard first — it only takes a moment and it's saved for next time.",
      );
      return;
    }
    // A scorecard the golfer saved themselves overrides the API's pars.
    const holes = resolveRoundHoles(setup);
    const saved = findSavedScorecard(setup);
    await requestCapturePermissions();
    const ok = await round.startRound(
      courseName.trim(),
      selectedCourseId,
      holes,
      holesPlayed,
      startHole,
    );
    // Non-blocking — a failed timestamp bump shouldn't tank the round. Keeps
    // the recents row ordered by what the golfer actually plays.
    if (ok && saved) void touchCoursePreset(saved.id);
  };

  // A recent course was tapped: adopt its setup and go straight to the
  // "which hole are you starting on" step — the same step the 9/18 selector
  // leads to. Nothing commits here; the golfer confirms on that step.
  const handleSelectRecent = useCallback((preset: CoursePreset) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCourseName(preset.course_name);
    setSelectedCourseId(preset.course_id ?? undefined);
    // Clear any hole data fetched for a DIFFERENT course — resolveRoundHoles
    // rebuilds it from this preset's saved pars when the round starts.
    setCourseHoles(undefined);
    setHolesPlayed(preset.holes_played);
    // normalize: a legacy 18-hole preset saved with start_hole 10 would
    // otherwise land on the step with nothing selected.
    setStartHole(normalizeStartHole(preset.holes_played, preset.start_hole));
    setLivePhase('start-hole');
  }, []);

  // Save the per-hole pars the user entered on the "Set the scorecard"
  // screen as a bookmark preset. On success we add the new preset to the
  // list and drop the user back on the setup screen — the course and holes
  // they were setting up are still in state, and the round is no longer
  // gated because we now hold its pars. `holePars` is positional, length =
  // holesPlayed. Errors are surfaced but non-destructive — the entered pars
  // stay on screen so the user can retry (e.g. after renaming a duplicate).
  const handleSaveScorecard = useCallback(async (holePars: number[]) => {
    setSavingScorecard(true);
    try {
      // Upsert by (user, name): re-saving a course you've already bookmarked
      // overwrites that scorecard in place instead of erroring on the
      // duplicate name, so correcting a wrong par just works.
      const saved = await upsertCoursePreset({
        course_id: selectedCourseId ?? null,
        course_name: courseName.trim(),
        holes_played: holesPlayed,
        start_hole: startHole,
        name: courseName.trim(),
        hole_pars: holePars,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Reflect the save immediately: drop any prior row for this preset and
      // put the freshly-saved one on top (most-recent-first, matching the
      // server's last_used_at ordering) so the corrected scorecard is what the
      // picker shows — and loads — next time.
      setPresets((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
      setLivePhase('setup');
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Could not save scorecard',
        'Something went wrong saving your scorecard. Please try again.',
      );
    } finally {
      setSavingScorecard(false);
    }
  }, [selectedCourseId, courseName, holesPlayed, startHole]);

  // Load the user's presets when they enter the Live setup screen. We
  // load lazily (not on tab mount) so we don't hammer the network for
  // users who only use Import.
  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;
    setPresetsLoading(true);
    listCoursePresets()
      .then((rows) => {
        if (cancelled) return;
        setPresets(rows);
      })
      .catch((err) => {
        // Non-fatal — the manual flow still works. Log so we know.
        console.log('[record] listCoursePresets failed:', err?.message);
      })
      .finally(() => {
        if (!cancelled) setPresetsLoading(false);
      });
    return () => { cancelled = true; };
  }, [mode]);

  const handleEndHole = () => {
    // Mid-recording (or mid-finalize) the in-flight clip hasn't landed in
    // round state: ending the hole now would score it one stroke short and
    // spill the clip's shot counter into the next hole.
    if (recordingBusy) {
      Alert.alert('Stop recording first', 'Stop the current clip before moving to the next hole.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    round.endHole();
  };

  const handlePreviousHole = () => {
    // Same mid-clip guard as Next Hole: stepping holes while a clip is still
    // recording/finalizing would reposition the pointer around a shot that
    // hasn't landed in round state yet.
    if (recordingBusy) {
      Alert.alert('Stop recording first', 'Stop the current clip before moving to the previous hole.');
      return;
    }
    round.previousHole();
  };

  const handlePenaltySelect = (type: PenaltyType) => {
    setShowPenalty(false);
    // Pickup finalizes the hole (and on the last hole, the round) — doing
    // that mid-recording unmounts the CameraView under an active
    // recordAsync and kills the clip. Other penalty types only bump the
    // shot counter and are safe.
    if (type === 'pickup' && recordingBusy) {
      Alert.alert('Stop recording first', 'Stop the current clip before picking up.');
      return;
    }
    round.addPenalty(type);
  };

  const handleRecordPress = () => {
    if (isNative) {
      // The MP4 finalize window (5–10s after a stop) can't accept a new
      // recordAsync — without this guard the button would silently drop the
      // press and feel broken on fast re-records (short putts). Give the tap
      // a warning haptic instead; the button also renders "Saving…" (below).
      if (camera.isFinalizing) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      // force: the on-screen button is an unambiguous user intent — an
      // early (<2s) stop cancels the recording (discarding the too-short
      // clip) instead of being silently swallowed like phantom clicker
      // events are.
      camera.toggleRecording({ force: true });
    } else {
      camera.simulateRecording();
    }
  };

  const handleCourseSelect = (course: { id: string; name: string }, holes: HoleData[]) => {
    setSelectedCourseId(course.id);
    setCourseHoles(holes.length > 0 ? holes : undefined);
  };

  // ---- IDLE STATES: either the chooser or the Live picker. ----
  // Combined into a single guard so TypeScript narrows roundState
  // correctly past the block. The two sub-renders are swapped via the
  // `mode` state variable rather than two separate top-level branches.
  if (!roundState || roundState.status === 'not_started') {
    if (mode === null) {
      // ---- IDLE STATE: Mode chooser ----
      // First entry into the Record tab shows two cards: Import vs Live.
      // The user picks one before we ask about course / preset (those
      // come in Phase C). This keeps the entry point honest about which
      // path they're starting rather than burying Import in a secondary
      // button under the live-recording UI like before.
      return (
      <GradientBackground>
        {/* paddingBottom clears the floating tab pill — on a small screen the
            mount card at the end of this column otherwise sits under it. */}
        <View
          style={{
            flex: 1,
            paddingTop: insets.top,
            padding: 24,
            paddingBottom: tabBarClearance(insets.bottom),
          }}
        >
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 8 }}>
            Record
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 32 }}>
            How are you capturing this round?
          </Text>

          {/* Orphaned round recovery — stays visible on the chooser so the
              user doesn't have to drill into Live to find an unfinished
              session waiting to be resumed. */}
          {orphanedRound && (
            <Card style={{ marginBottom: 16, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <AlertCircle size={18} color={theme.colors.bogey} />
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', flex: 1 }}>
                  Unfinished round at {orphanedRound.course_name}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  title="Resume"
                  onPress={async () => {
                    // Resuming drops the user straight onto the live camera,
                    // so it is a commit to capture just like Start Round —
                    // ask here rather than letting the permission screen or a
                    // mid-round clip save be the first prompt.
                    await requestCapturePermissions();
                    round.recoverRound(orphanedRound.id);
                    setOrphanedRound(null);
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Discard"
                  onPress={() => {
                    round.discardRound(orphanedRound.id);
                    setOrphanedRound(null);
                  }}
                  variant="ghost"
                  style={{ flex: 1 }}
                />
              </View>
            </Card>
          )}

          {/* Live recording card */}
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setMode('live');
              setLivePhase('setup');
            }}
            style={({ pressed }) => ({
              borderRadius: theme.radius.lg,
              padding: 20,
              backgroundColor: theme.colors.surface,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              marginBottom: 12,
              opacity: pressed ? 0.85 : 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              ...theme.shadows.glow,
            })}
          >
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: theme.colors.primary,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Video size={28} color="#FFFFFF" strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary }}>
                Live recording
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
                Record each shot as you play with the BLE clicker.
              </Text>
            </View>
            <ChevronRight size={20} color={theme.colors.textTertiary} />
          </Pressable>

          {/* Import card */}
          <Pressable
            ref={importTarget.ref}
            onLayout={importTarget.onLayout}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/round/import');
            }}
            style={({ pressed }) => ({
              borderRadius: theme.radius.lg,
              padding: 20,
              backgroundColor: theme.colors.surface,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              opacity: pressed ? 0.85 : 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
            })}
          >
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: theme.colors.surfaceElevated ?? theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Film size={28} color={theme.colors.primary} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ ...theme.typography.h3, color: theme.colors.textPrimary }}>
                Import clips
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
                Pick already-captured videos from your Photos library.
              </Text>
            </View>
            <ChevronRight size={20} color={theme.colors.textTertiary} />
          </Pressable>

          {/* Clippar Mount cross-sell — compact, dismissible, idle-state only.
              The kit is a PHYSICAL product, so the CTA links out to Safari
              (App Review 3.1.3(e): physical goods must not use IAP). The X
              persists via lib/mountOffer so the card stays gone. */}
          {mountCardVisible && (
            <View
              style={{
                marginTop: 16,
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
              }}
            >
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  Linking.openURL(config.shop.mountUrl).catch(() => {});
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  padding: 14,
                  paddingRight: 40, // keep text clear of the X
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: theme.colors.primaryMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Smartphone size={20} color={theme.colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' }}>
                    Get the Clippar Mount — record hands-free
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                    Mount + clicker + charger · {config.shop.mountPriceLabel}
                  </Text>
                </View>
              </Pressable>
              <Pressable
                onPress={handleDismissMountCard}
                hitSlop={10}
                style={{ position: 'absolute', top: 10, right: 10 }}
              >
                <X size={16} color={theme.colors.textTertiary} />
              </Pressable>
            </View>
          )}
        </View>
      </GradientBackground>
    );
  }

    // ---- IDLE STATE: Live recording — "which hole are you starting on" ----
    // The last step before a round begins, reached from BOTH the 9/18
    // selector and a tapped recent course. Shotgun starts are routine, so
    // the tee-off hole is asked explicitly rather than assumed to be 1.
    if (livePhase === 'start-hole') {
      const holeOptions = startHoleOptions(holesPlayed);
      return (
        <GradientBackground>
          <ScrollView
            contentContainerStyle={{
              paddingTop: insets.top,
              padding: 24,
              paddingBottom: tabBarClearance(insets.bottom),
            }}
            keyboardShouldPersistTaps="handled"
          >
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setLivePhase('setup');
              }}
              hitSlop={12}
              style={{ marginBottom: 12, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <ArrowLeft size={20} color={theme.colors.textSecondary} />
              <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Back</Text>
            </Pressable>

            <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 8 }}>
              Which hole are you starting on?
            </Text>
            <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 24 }}>
              {courseName.trim()} · {holesPlayed} holes
            </Text>

            <Segmented
              value={String(startHole)}
              options={holeOptions.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => setStartHole(v === '10' ? 10 : 1)}
            />

            {/* A full 18 has exactly one valid answer: the round model plays
                holesPlayed consecutive holes from the start hole, so 18 from
                10 would score holes 19..27. Say so rather than offering a
                choice that can't work. */}
            {holesPlayed === 18 && (
              <Text style={{ color: theme.colors.textTertiary, fontSize: 13, marginTop: 10 }}>
                A full 18 always tees off on hole 1. Shotgun start? Go back and pick 9 holes,
                then tee off on 10.
              </Text>
            )}

            {/* Same gate as the setup screen, re-checked for the hole they
                actually chose — a saved back-nine scorecard doesn't cover a
                front-nine round. "Set the scorecard" is offered right here so
                a blocked golfer is never stuck. */}
            {!gate.allowed && gate.reason === 'unknown-course' && (
              <Text style={{ color: theme.colors.bogey, fontSize: 13, marginTop: 20 }}>
                We don't have this course's pars for these holes yet. Set the scorecard so your
                reel shows real numbers.
              </Text>
            )}

            <Button
              title="Start Round"
              onPress={startRound}
              disabled={!gate.allowed}
              style={{
                marginTop: 24,
                ...(gate.allowed ? theme.shadows.glow : {}),
              }}
            />

            {!gate.allowed && (
              <Button
                title="Set the scorecard"
                variant="secondary"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setLivePhase('scorecard');
                }}
                style={{ marginTop: 12 }}
              />
            )}
          </ScrollView>
        </GradientBackground>
      );
    }

    // ---- IDLE STATE: Live recording — "Set the scorecard" par entry ----
    // Reached from the setup screen once a course + holes are chosen. Lets
    // the user pick each hole's par and save it as a bookmark preset whose
    // hole_pars override the API par on future rounds.
    if (livePhase === 'scorecard') {
      return (
        <ScorecardSetupScreen
          courseName={courseName.trim()}
          holesPlayed={holesPlayed}
          startHole={startHole}
          saving={savingScorecard}
          // Re-saving a course you've already bookmarked overwrites it, so
          // label the CTA "Update…" instead of "Save…" in that case.
          isUpdate={!!findPresetToUpdate(presets, courseName.trim())}
          // This screen renders inside the tabs navigator, so its pinned Save
          // CTA has to clear the floating tab pill like every other setup
          // step. It pads for the safe-area inset itself, hence the bare pill
          // clearance rather than tabBarClearance().
          bottomClearance={TAB_BAR_CLEARANCE}
          onBack={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setLivePhase('setup');
          }}
          onSave={handleSaveScorecard}
        />
      );
    }

    // ---- IDLE STATE: Live recording — setup screen ----
    // The hub of the Live flow: recent courses, course search and 9/18.
    // Continue leads to the start-hole step, which is where a round is
    // actually started.
    //
    // The golfer hasn't chosen a nine yet, so the gate here asks "do we know
    // this course for ANY start hole it could tee off on" — someone whose only
    // saved scorecard is the back nine must still reach the step where they'd
    // say so. startRoundGate then checks the hole they actually pick.
    // While the presets fetch is still in flight we may not know yet that the
    // golfer HAS a scorecard for this course, so don't block (or accuse them
    // of a new course) on incomplete knowledge — startRoundGate on the next
    // step is the guarantee.
    const courseReady = courseName.trim().length > 0;
    const courseKnown = presetsLoading || isCourseKnownForAnyStart(setup);
    const canContinue = courseReady && courseKnown;
    return (
      <GradientBackground>
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top,
            padding: 24,
            // Clear the floating tab pill. At the old flat 48 the Start Round
            // button and the holes selector sat underneath it on device.
            paddingBottom: tabBarClearance(insets.bottom),
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setMode(null);
              setCourseName('');
              setSelectedCourseId(undefined);
              setCourseHoles(undefined);
              setHolesPlayed(18);
              setStartHole(1);
            }}
            hitSlop={12}
            style={{ marginBottom: 12, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <ArrowLeft size={20} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Back</Text>
          </Pressable>
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 8 }}>
            Live recording
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 24 }}>
            Set up a new round.
          </Text>

          {/* Shutter Status */}
          <Pressable
            onPress={() => router.push('/profile/bluetooth')}
            style={{ marginBottom: 24 }}
          >
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {shutter.connected ? (
                <Bluetooth size={20} color={theme.colors.connected} />
              ) : (
                <BluetoothOff size={20} color={theme.colors.disconnected} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                  {shutter.statusLabel}
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                  {shutter.connected
                    ? 'Press the button to start/stop recording'
                    : 'Tap to set up your clicker'}
                </Text>
              </View>
              <Badge variant={shutter.connected ? 'connected' : 'disconnected'} />
              {!shutter.connected && (
                <ChevronRight size={16} color={theme.colors.textTertiary} />
              )}
            </Card>
          </Pressable>

          {/* Recently used courses / saved scorecards — the fast path. Sits
              above the search because for a repeat round it IS the setup. */}
          <RecentScorecards
            presets={recentSetups(presets)}
            loading={presetsLoading}
            onSelect={handleSelectRecent}
          />

          {/* Course search */}
          <CourseSearch
            value={courseName}
            onChangeText={setCourseName}
            onSelectCourse={handleCourseSelect}
          />

          {/* Round options. Only show holes selector once a course is in the
              field — for a brand new user with no course typed there's
              nothing yet to configure. */}
          {courseName.trim().length > 0 && (
            <View style={{ marginTop: 20 }}>
              <Text style={{ ...theme.typography.bodySmall, color: theme.colors.textSecondary, fontWeight: '600', marginBottom: 8 }}>
                Holes
              </Text>
              <Segmented
                value={String(holesPlayed)}
                options={[{ value: '9', label: '9' }, { value: '18', label: '18' }]}
                onChange={(v) => {
                  const next = v === '9' ? 9 : 18;
                  setHolesPlayed(next);
                  // 18-hole rounds can't start on hole 10 (would score holes
                  // 19..27), so drop a back-nine choice on the way through.
                  setStartHole((cur) => normalizeStartHole(next, cur));
                }}
              />
              {/* The start hole is NOT asked here any more — it's the next
                  step, so both this path and a tapped recent course confirm
                  it the same way. */}
            </View>
          )}

          {/* A course we hold no pars for would put an invented scorecard on
              a reel that can never be re-recorded, so Continue waits until
              the scorecard is set. A course we already know is never gated. */}
          {courseReady && !canContinue && (
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 20 }}>
              New course — we don't have its pars yet. Set the scorecard once and it's saved
              for every round you play here.
            </Text>
          )}

          <Button
            title="Continue"
            onPress={() => {
              // Land the step on a hole this round can actually start from.
              setStartHole((cur) => normalizeStartHole(holesPlayed, cur));
              setLivePhase('start-hole');
            }}
            disabled={!canContinue}
            style={{
              marginTop: courseReady ? 20 : 24,
              ...(canContinue ? theme.shadows.glow : {}),
            }}
          />

          {/* Save the course's scorecard as a bookmark. The golf-course API's
              par data isn't trustworthy, so this lets the user set each hole's
              par once and reuse it (the saved pars override the API on future
              rounds). Only offered once a course is in the field. */}
          {courseReady && (
            <Button
              title="Set the scorecard"
              variant="secondary"
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setLivePhase('scorecard');
              }}
              style={{ marginTop: 12 }}
            />
          )}

          {/* Dev: Simulate BLE press */}
          {__DEV__ && (
            <Button
              title="[DEV] Simulate Shutter Press"
              onPress={shutter.simulatePress}
              variant="ghost"
              style={{ marginTop: 16 }}
            />
          )}
        </ScrollView>
      </GradientBackground>
    );
  }

  // ---- FINISHED STATE ----
  // From here roundState is guaranteed non-null because both null and
  // 'not_started' were handled above.
  if (roundState.status === 'finished') {
    return (
      <GradientBackground>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, paddingTop: insets.top }}>
          <CheckCircle size={64} color={theme.colors.primary} />
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginTop: 24 }}>
            Round Complete
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginTop: 8, textAlign: 'center' }}>
            {roundState.scores.length} holes · {roundState.clips.length} clips at {roundState.courseName}
          </Text>
          <Text style={{ ...theme.typography.score, color: theme.colors.textPrimary, marginTop: 16 }}>
            {roundState.totalScore}
          </Text>
          {roundState.totalPar > 0 && (
            <Text
              style={{
                fontSize: 18,
                fontWeight: '700',
                color:
                  roundState.totalScore - roundState.totalPar < 0
                    ? theme.colors.birdie
                    : roundState.totalScore - roundState.totalPar === 0
                      ? theme.colors.par
                      : theme.colors.bogey,
                marginTop: 4,
              }}
            >
              {roundState.totalScore - roundState.totalPar === 0
                ? 'Even'
                : roundState.totalScore - roundState.totalPar > 0
                  ? `+${roundState.totalScore - roundState.totalPar}`
                  : roundState.totalScore - roundState.totalPar}
            </Text>
          )}
          <Button
            title="End Round"
            onPress={async () => {
              console.log('[EndRound] tapped — bundle endround-v1, navigating to editor');
              const roundId = roundState.roundId;
              const courseNameSnapshot = roundState.courseName;
              round.endRound();
              // Mirror import flow: silent background upload only if cloud
              // backup is on, then drop the user on the editor (trim/preview)
              // page so they can review their clips. No "Submitting for
              // processing" banner — trimming already happened per-clip
              // during recording, this is just background backup.
              try {
                const cloudBackupOn = await getCloudBackupEnabled();
                if (cloudBackupOn) {
                  void enqueueRoundUpload(roundId, courseNameSnapshot, 'local-only');
                }
              } catch {}
              round.resetRound();
              setCourseName('');
              // Send the user back to the chooser next time they hit the
              // Record tab — fresh start, not a stale 'live' selection.
              setMode(null);
              router.replace(`/round/editor?roundId=${roundId}`);
            }}
            style={{ marginTop: 32, width: '100%' }}
          />
          <Button
            title="Discard Round"
            onPress={() => {
              Alert.alert('Discard Round', 'Are you sure? This cannot be undone.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Discard',
                  style: 'destructive',
                  onPress: () => {
                    round.discardRound(roundState.roundId);
                    setCourseName('');
                    setMode(null);
                  },
                },
              ]);
            }}
            variant="ghost"
            style={{ marginTop: 12, width: '100%' }}
          />
        </View>
      </GradientBackground>
    );
  }

  // ---- CAMERA PERMISSION CHECK (native only) ----
  if (isNative && camera.hasPermission === false) {
    return <CameraPermissionScreen onRetry={camera.requestPermission} />;
  }

  // ---- ACTIVE RECORDING STATE (FULL SCREEN) ----
  const scoreToPar = roundState.totalScore - roundState.totalPar;

  return (
    <View style={styles.fullScreen}>
      {/* Camera fills entire screen */}
      {/* mute — AUDIO ON unless the user denied the microphone. The whole
          detection pipeline degrades gracefully without an audio track
          (ShotDetectorModule.swift returns [] for audio transients and falls
          back to pose alone), so a mic denial must yield SILENT clips, not a
          dead camera. It used to yield a dead camera: useCamera AND-ed the mic
          result into hasPermission, so denying the mic parked the user on
          CameraPermissionScreen forever (spec 5.6, overbroad permissions).
          Compared against `false` explicitly so the still-hydrating null state
          keeps audio on and never flips `mute` mid-session (flipping it
          attaches/detaches the mic input on a live AVCaptureSession).

          AUDIO ON is itself root-cause fixed. The -10868
          (kAudioUnitErr_FormatNotSupported) failure was react-native-volume-
          manager's addVolumeListener forcing the shared AVAudioSession to
          .ambient (a playback-only category) just to attach its volume-clicker
          KVO — which clobbered the camera's .playAndRecord session and killed
          recordAsync ~2s in. Patched RNVM (patches/react-native-volume-
          manager+2.0.8.patch) to attach that KVO WITHOUT stamping a category,
          so the expo-camera patch's .playAndRecord holds and clips record with
          audio while the clicker still works.
          REQUIRES a native rebuild — the RNVM patch is compiled Obj-C, so a
          Metro reload alone won't include it; the dev client must be rebuilt
          (expo run:ios / new EAS dev build). */}
      {isNative && CameraView ? (
        <GestureDetector gesture={pinchGesture}>
        <CameraView
          ref={camera.cameraRef}
          style={StyleSheet.absoluteFillObject}
          facing={facing}
          // Continuous digital zoom (0..1) driven by the two-finger pinch over
          // the preview, applied on top of `selectedLens`. Capture-side only —
          // does not affect the recorded-file path into the shot detector.
          zoom={zoom}
          // iOS lens selection: pins 1× (wide) by default, 0.5× (ultra-wide)
          // when toggled. Undefined until the lens list arrives, then it snaps
          // to the wide lens. No-op on Android (selectedLens is iOS-only).
          selectedLens={selectedLens}
          onAvailableLensesChanged={(e) => setAvailableLenses(e.lenses)}
          // Belt-and-suspenders: also pull the lens list the moment the camera
          // is ready, so 1× engages even if the change event doesn't fire on
          // first mount (otherwise it'd sit on the 0.5× virtual-device default).
          onCameraReady={async () => {
            // Camera-ready marks the end of an audio-session / capture-
            // session (re)start — the exact moments iOS emits phantom
            // volume notifications (mount, unlock after a between-shots
            // pocket, mediaServicesWereReset). Re-arm the grace window from
            // HERE so it covers the notification even when session restart
            // takes longer than the fixed foreground grace (older devices).
            shutter.armVolumeGrace();
            try {
              const lenses = await camera.cameraRef.current?.getAvailableLensesAsync();
              if (Array.isArray(lenses) && lenses.length) setAvailableLenses(lenses);
            } catch {}
          }}
          mode="video"
          videoQuality="1080p"
          mute={camera.hasMicPermission === false}
          // Phone torch as a "recording in progress" indicator. Cheap BLE
          // shutters don't expose their LED, so we use the rear camera
          // flash instead — visible from wherever the phone is pointed
          // (typically AT the golfer for a tripod setup). Follows
          // camera.isRecording so it turns on the instant recording starts
          // and off the instant it stops — but only when the user has the
          // Recording light toggle on (recording settings sheet).
          enableTorch={camera.isRecording && lightEnabled}
        />
        </GestureDetector>
      ) : (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 16 }}>Camera Preview</Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 13, marginTop: 4 }}>(Available on device build)</Text>
        </View>
      )}

      {/* Pinch-zoom level indicator. Non-interactive (pointerEvents none so it
          never eats a touch), centered horizontally and parked in the upper-
          middle of the preview — clear of the ScoreOverlay/badges up top and
          the record button + hole readouts down at the bottom. Visible while
          pinching and for ~0.9s after. The x figure is an approximation, not
          an exact optical focal length. */}
      {zoomIndicatorVisible && (
        <View pointerEvents="none" style={styles.zoomIndicator}>
          <Text style={styles.zoomIndicatorText}>{zoomLabel}</Text>
        </View>
      )}

      {/* Score overlay at top */}
      <ScoreOverlay
        holeNumber={roundState.currentHole}
        par={currentPar}
        currentShot={roundState.currentShot}
        scoreToPar={scoreToPar}
        isRecording={camera.isRecording}
        topInset={insets.top}
      />

      {/* Shutter status badge — top left */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + 52,
          left: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: 'rgba(0,0,0,0.5)',
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 16,
        }}
      >
        {shutter.connected ? (
          <Bluetooth size={12} color={theme.colors.connected} />
        ) : (
          <BluetoothOff size={12} color={theme.colors.textTertiary} />
        )}
        <Text style={{
          color: shutter.connected ? theme.colors.connected : theme.colors.textTertiary,
          fontSize: 11,
          fontWeight: '600',
        }}>
          {shutter.connected ? 'Clicker' : 'No Clicker'}
        </Text>
      </View>

      {/* Recording settings gear — top left, under the shutter badge.
          Hidden during the tutorial to keep the practice run focused. */}
      {!tutorialActive && (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowRecordingSettings(true);
          }}
          hitSlop={8}
          style={{
            position: 'absolute',
            top: insets.top + 92,
            left: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: 'rgba(0,0,0,0.5)',
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 16,
          }}
        >
          <Settings2 size={12} color={theme.colors.textSecondary} />
          <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' }}>
            Options
          </Text>
        </Pressable>
      )}

      {/* End Round button — top right below overlay. Hidden during the
          tutorial so a stray tap can't finalize the practice round. */}
      {!tutorialActive && (
        <Pressable
          onPress={() => {
            // Ending the round flips to the FINISHED screen and unmounts
            // the CameraView — mid-recording (or mid-finalize) that aborts
            // the in-flight recordAsync and loses the final clip of the
            // round. Mirror handleReviewRound's guard.
            if (recordingBusy) {
              Alert.alert('Stop recording first', 'Stop the current clip and let it finish saving before ending the round.');
              return;
            }
            if (isNative) {
              Alert.alert(
                'End Round',
                `End round after hole ${roundState.currentHole}?`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'End Round', onPress: () => round.endRoundEarly() },
                ]
              );
            } else {
              round.endRoundEarly();
            }
          }}
          style={{
            position: 'absolute',
            top: insets.top + 52,
            right: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            backgroundColor: 'rgba(0,0,0,0.5)',
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 16,
          }}
        >
          <Flag size={12} color={theme.colors.textSecondary} />
          <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' }}>
            End Round
          </Text>
        </Pressable>
      )}

      {/* Bottom controls overlay */}
      <View style={[styles.bottomControls, { paddingBottom: insets.bottom + 16 }]}>
        {/* Camera framing row: zoom toggle (left) + flip (right). Hidden during
            the tutorial to keep the practice run focused. Both are disabled
            mid-recording so the capture session isn't reconfigured under a
            running clip. */}
        {!tutorialActive && (
          <View style={styles.cameraControlsRow}>
            {hasUltraWide ? (
              <View style={styles.zoomToggle}>
                {(['0.5x', '1x'] as const).map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => selectZoom(m)}
                    disabled={camera.isRecording}
                    hitSlop={6}
                    style={[styles.zoomPill, zoomMode === m && styles.zoomPillActive]}
                  >
                    <Text
                      style={[
                        styles.zoomPillText,
                        zoomMode === m && styles.zoomPillTextActive,
                      ]}
                    >
                      {m}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View />
            )}

            <Pressable
              onPress={flipCamera}
              disabled={camera.isRecording}
              hitSlop={8}
              style={styles.flipButton}
            >
              <SwitchCamera
                size={20}
                color={camera.isRecording ? theme.colors.textTertiary : '#fff'}
              />
            </Pressable>
          </View>
        )}

        {/* Action buttons row */}
        <View style={styles.actionRow}>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setShowPenalty(true);
            }}
            style={styles.actionButton}
          >
            <AlertTriangle size={16} color="#FF6B6B" />
            <Text style={styles.actionButtonText}>Penalty</Text>
          </Pressable>

          {/* Record button — large, centered. Dims during the finalize
              window so a dropped re-record press reads as "busy", not broken. */}
          <Pressable
            onPress={handleRecordPress}
            style={[
              styles.recordButtonContainer,
              camera.isFinalizing && { opacity: 0.4 },
            ]}
          >
            <RecordingIndicator isRecording={camera.isRecording} />
          </Pressable>

          {/* Hole navigation — Previous / Next. Previous is disabled on the
              first hole played (startHole) since there's nowhere to step back
              to; a back-nine round clamps at hole 10. Both share the mid-clip
              guard so a step can't reposition around an in-flight recording. */}
          <View style={styles.holeNavGroup}>
            <Pressable
              onPress={handlePreviousHole}
              disabled={roundState.currentHole <= roundState.startHole}
              style={[
                styles.holeNavButton,
                roundState.currentHole <= roundState.startHole && { opacity: 0.35 },
              ]}
            >
              <ChevronLeft size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.actionButtonText, { color: theme.colors.textSecondary }]}>
                Prev
              </Text>
            </Pressable>

            <Pressable onPress={handleEndHole} style={styles.holeNavButton}>
              <ChevronRight size={16} color={theme.colors.primary} />
              <Text style={[styles.actionButtonText, { color: theme.colors.primary }]}>
                Next Hole
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Bottom Sheets */}
      <PenaltySheet
        visible={showPenalty}
        onSelect={handlePenaltySelect}
        onDismiss={() => setShowPenalty(false)}
      />

      <RecordingSettingsSheet
        visible={showRecordingSettings}
        onDismiss={() => setShowRecordingSettings(false)}
        lightEnabled={lightEnabled}
        onToggleLight={setLightEnabled}
        onReviewRound={handleReviewRound}
        onDeleteLastShot={handleDeleteLastShot}
        canDeleteLastShot={canDeleteLastShot}
        currentHole={roundState.currentHole}
        onUndoDelete={handleUndoDelete}
        undoableDeleteCount={round.undoableDeleteCount}
        lastDeletedHole={round.lastDeletedHole}
        onReplayTutorial={handleReplayTutorial}
      />

      {/* Clicker tutorial. Opens on a BLOCKING intro card (nothing underneath
          is pressable) so practice mode can only ever be entered deliberately;
          choosing "Practise first" switches it to the non-blocking coach,
          where real actions fire, clips are discarded, and resetToStart wipes
          the round clean at the end. Declining leaves the round untouched. */}
      {tutorialActive && (
        <ClickerTutorial
          phase={tutorialPhase}
          onStartPractice={startTutorialPractice}
          isRecording={camera.isRecording}
          currentHole={roundState.currentHole}
          penaltyCount={penaltyCount}
          connected={shutter.connected}
          onFinish={endTutorial}
          onSkip={endTutorial}
          dontShowAgain={dontShowAgain}
          onDontShowAgainChange={setDontShowAgain}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    backgroundColor: '#000',
  },
  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 16,
    backgroundColor: 'transparent',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: 70,
  },
  holeNavGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  holeNavButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: 56,
  },
  actionButtonText: {
    color: '#FF6B6B',
    fontSize: 11,
    fontWeight: '600',
  },
  recordButtonContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    marginBottom: 18,
  },
  zoomToggle: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 18,
    padding: 3,
    gap: 2,
  },
  zoomPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 15,
  },
  zoomPillActive: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  zoomPillText: {
    color: theme.colors.textTertiary,
    fontSize: 13,
    fontWeight: '700',
  },
  zoomPillTextActive: {
    color: '#fff',
  },
  flipButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomIndicator: {
    position: 'absolute',
    top: '38%',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: theme.radius.full,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  zoomIndicatorText: {
    color: theme.colors.accentGold,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
    fontVariant: ['tabular-nums'],
  },
});
