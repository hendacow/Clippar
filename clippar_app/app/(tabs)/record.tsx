import { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable, Alert, Platform, StyleSheet, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useRecordingContext } from '@/contexts/RecordingContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Bluetooth,
  BluetoothOff,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  AlertCircle,
  Flag,
  Film,
  Video,
  ArrowLeft,
} from 'lucide-react-native';
import { theme } from '@/constants/theme';
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
import { PresetPickerScreen } from '@/components/record/PresetPickerScreen';
import { PresetConfirmSheet } from '@/components/record/PresetConfirmSheet';
import { useBLE } from '@/hooks/useBLE';
import { useShutter } from '@/hooks/useShutter';
import { useRound } from '@/hooks/useRound';
import { useCamera } from '@/hooks/useCamera';
import { useLocation } from '@/hooks/useLocation';
import { getOrphanedRounds, getCloudBackupEnabled } from '@/lib/storage';
import { enqueueRoundUpload } from '@/lib/uploadQueue';
import { listCoursePresets, touchCoursePreset } from '@/lib/api';
import { useOnboardingTarget } from '@/hooks/useOnboardingTarget';
import type { PenaltyType, ClipMetadata, HoleData } from '@/types/round';
import type { CoursePreset } from '@/types/preset';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const DEFAULT_PAR = 4;

// Conditionally import CameraView for native
const CameraView = isNative
  ? (require('expo-camera') as typeof import('expo-camera')).CameraView
  : null;

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const ble = useBLE();
  const shutter = useShutter();
  const round = useRound();
  const { getCurrentLocation } = useLocation();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[] | undefined>();
  const [showPenalty, setShowPenalty] = useState(false);
  const [orphanedRound, setOrphanedRound] = useState<{ id: string; course_name: string } | null>(null);
  const importTarget = useOnboardingTarget('import-card');

  // Wave 3 mode chooser. The Record tab now shows two cards on entry —
  // Import (clips from Photos) and Live (BLE-triggered camera recording).
  // null = chooser visible; 'live' = course picker + camera flow visible.
  // The Import path uses router.push to /round/import and never sets
  // this to 'import' (no need — that flow lives on a different route).
  const [mode, setMode] = useState<null | 'live'>(null);

  // Wave 3 Phase D-redo: when the user enters Live mode AND has saved
  // presets, we now show a Preset Picker first as an intermediate step,
  // before the manual setup screen. `livePhase` distinguishes the two:
  //   - 'preset-picker' = list of saved rounds + "Set up new" CTA
  //   - 'setup'         = the existing course-search / holes / start-hole
  //                       manual setup screen
  // Users without presets jump straight to 'setup' since there's nothing
  // to pick from.
  const [livePhase, setLivePhase] = useState<'preset-picker' | 'setup'>('setup');

  // Wave 3 Phase D-redo: when a preset is tapped on the picker we open
  // a bottom-sheet confirmation that lets the user override the start
  // hole before kicking off the round. Holds the preset whose sheet is
  // currently open; null = sheet closed.
  const [confirmingPreset, setConfirmingPreset] = useState<CoursePreset | null>(null);

  // Wave 3 Phase C: round setup. Defaults match the legacy hard-coded
  // behaviour (full 18 from hole 1). When a preset is tapped these get
  // overwritten with its values; the manual flow uses the segmented
  // controls below the course search to set them.
  const [holesPlayed, setHolesPlayed] = useState<9 | 18>(18);
  const [startHole, setStartHole] = useState<1 | 10>(1);
  const [presets, setPresets] = useState<CoursePreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);

  const { setRecordingActive } = useRecordingContext();
  const roundState = round.state;
  const isActive = roundState?.status === 'in_progress';

  // Camera hook — only active when round is in progress
  const camera = useCamera({
    roundId: roundState?.roundId ?? '',
    holeNumber: roundState?.currentHole ?? 1,
    shotNumber: roundState?.currentShot ?? 1,
    getLocation: getCurrentLocation,
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

  // Hide tab bar during active recording
  useEffect(() => {
    setRecordingActive(isActive);
    return () => { setRecordingActive(false); };
  }, [isActive, setRecordingActive]);

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
    if (!isActive) return;

    const unsubscribe = shutter.onClick(({ count }) => {
      console.log(`[record] onClick count=${count} isRecording=${camera.isRecording} ts=${Date.now() % 100000}`);
      // count===1 while recording would mean the onPress fast-path failed
      // to short-circuit (e.g. clearPendingClicks didn't run). Log so we
      // catch regressions, then bail — onPress already toggled.
      if (camera.isRecording) {
        console.log('[record] onClick fired while recording — IGNORED (onPress should have handled)');
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
      }
    });

    return unsubscribe;
  }, [
    shutter.onClick,
    isActive,
    camera.toggleRecording,
    camera.simulateRecording,
    camera.isRecording,
    round.endHole,
    round.addPenalty,
  ]);

  // Immediate-press handler. Two jobs:
  //   1. ALWAYS: light haptic so the user feels the press registered, even
  //      though the gesture-resolution path is debounced by ~1s.
  //   2. WHILE RECORDING: stop the clip instantly. We don't need to wait
  //      for potential double/triple because those are no-ops mid-clip
  //      anyway. We also call clearPendingClicks() so the same press
  //      doesn't trigger an onClick 1s later that would start a NEW
  //      recording.
  useEffect(() => {
    if (!isActive) return;
    return shutter.onPress(() => {
      if (camera.isRecording) {
        console.log('[record] onPress: instant stop (was recording)');
        shutter.clearPendingClicks();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
    isActive,
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

  const currentPar = roundState?.courseHoles
    ? (roundState.courseHoles.find((h) => h.holeNumber === roundState.currentHole)?.par ?? DEFAULT_PAR)
    : DEFAULT_PAR;

  // Manual-flow start: user typed/selected a course and (optionally) tweaked
  // the holes / start-hole selectors. Validates and kicks off round.startRound.
  const startRound = async () => {
    if (!courseName.trim()) {
      Alert.alert('Course Name', 'Please enter or select a course to start.');
      return;
    }
    await round.startRound(
      courseName.trim(),
      selectedCourseId,
      courseHoles,
      holesPlayed,
      startHole,
    );
  };

  // Preset-flow start: user tapped one of their saved presets and
  // (optionally) overrode some setup values in the Confirm Sheet. Pre-fills
  // the setup state and kicks off the round directly — the whole point
  // of presets is one-tap-and-go for repeat visits. Best-effort touches
  // last_used_at so the preset sorts to the top of the picker next time.
  //
  // Phase D-redo: the `overrides` arg carries any values the user changed
  // on the Confirm Sheet (currently just startHole). It's optional so
  // callers can still hand-off a "use the preset as-is" start when there's
  // no confirmation step (e.g. future programmatic shortcuts).
  const startFromPreset = useCallback(async (
    preset: CoursePreset,
    overrides?: { startHole?: 1 | 10 }
  ) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const effectiveStartHole = overrides?.startHole ?? preset.start_hole;
    // Mirror state into the form fields so a back-out keeps the values
    // visible in case the round fails to start.
    setCourseName(preset.course_name);
    setSelectedCourseId(preset.course_id ?? undefined);
    setCourseHoles(undefined); // preset doesn't carry the per-hole par data
    setHolesPlayed(preset.holes_played);
    setStartHole(effectiveStartHole);

    const ok = await round.startRound(
      preset.course_name,
      preset.course_id ?? undefined,
      undefined,
      preset.holes_played,
      effectiveStartHole,
    );
    if (ok) {
      // Non-blocking — failed timestamp bump shouldn't tank the round.
      void touchCoursePreset(preset.id);
    }
  }, [round.startRound]);

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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    round.endHole();
  };

  const handlePenaltySelect = (type: PenaltyType) => {
    setShowPenalty(false);
    round.addPenalty(type);
  };

  const handleRecordPress = () => {
    if (isNative) {
      camera.toggleRecording();
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
        <View style={{ flex: 1, paddingTop: insets.top, padding: 24 }}>
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
                  onPress={() => {
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
              // Phase D-redo: if the user already has saved presets, land
              // on the picker so they can one-tap into a repeat round.
              // Otherwise skip straight to manual setup — no point in an
              // empty picker. The picker's useEffect handles fetching;
              // we make the call locally on the snapshot we have right now
              // so the decision is synchronous.
              setLivePhase(presets.length > 0 ? 'preset-picker' : 'setup');
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
        </View>
      </GradientBackground>
    );
  }

    // ---- IDLE STATE: Live recording — Preset Picker (Phase D-redo) ----
    // Reached when the user picked 'Live' AND has at least one saved
    // preset. The picker lists their saved rounds with a "Set up new
    // round" CTA. Tapping a preset opens the PresetConfirmSheet (bottom
    // sheet) so the user can override the start hole before kicking off.
    // The ConfirmSheet is rendered as a sibling so it can portal-overlay
    // on top of the picker.
    if (livePhase === 'preset-picker') {
      return (
        <>
          <PresetPickerScreen
            presets={presets}
            loading={presetsLoading}
            title="Start a round"
            subtitle="Tap a saved round for one-tap setup, or start fresh."
            onSelectPreset={(preset) => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setConfirmingPreset(preset);
            }}
            onSetUpNew={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setLivePhase('setup');
            }}
            onBack={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setMode(null);
              setLivePhase('setup'); // reset for next entry
            }}
          />
          <PresetConfirmSheet
            preset={confirmingPreset}
            ctaLabel="Start round"
            onCancel={() => setConfirmingPreset(null)}
            onConfirm={({ startHole: chosenStartHole }) => {
              const target = confirmingPreset;
              setConfirmingPreset(null);
              if (target) {
                // Fire and forget — round.startRound has its own error
                // surface (alerts on failure). Don't await here so the
                // sheet animation can complete cleanly.
                void startFromPreset(target, { startHole: chosenStartHole });
              }
            }}
          />
        </>
      );
    }

    // ---- IDLE STATE: Live recording — manual setup screen ----
    // Reached when the user picked 'Live' AND either has no presets OR
    // tapped "Set up new round" on the picker. Course search + 9/18 +
    // start-hole selectors for explicit setup.
    return (
      <GradientBackground>
        <ScrollView
          contentContainerStyle={{ paddingTop: insets.top, padding: 24, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              // Back-navigation: if the user has presets, return to the
              // picker so they can switch their mind. Otherwise drop all
              // the way back to the chooser (no picker exists to return to).
              if (presets.length > 0) {
                setLivePhase('preset-picker');
              } else {
                setMode(null);
              }
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

          {/* Saved-rounds list previously lived here. Moved to the
              PresetPickerScreen (Phase D-redo) which shows BEFORE this
              setup screen for users with presets. */}

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
                  setHolesPlayed(v === '9' ? 9 : 18);
                  // 18-hole rounds can't start on hole 10 (would only play 9).
                  // Reset to 1 if the user toggles back to 18.
                  if (v === '18') setStartHole(1);
                }}
              />

              {holesPlayed === 9 && (
                <>
                  <Text style={{
                    ...theme.typography.bodySmall,
                    color: theme.colors.textSecondary,
                    fontWeight: '600',
                    marginTop: 16,
                    marginBottom: 8,
                  }}>
                    Starting hole
                  </Text>
                  <Segmented
                    value={String(startHole)}
                    options={[
                      { value: '1', label: 'Front 9' },
                      { value: '10', label: 'Back 9' },
                    ]}
                    onChange={(v) => setStartHole(v === '10' ? 10 : 1)}
                  />
                </>
              )}
            </View>
          )}

          <Button
            title="Start Round"
            onPress={startRound}
            style={{
              marginTop: 24,
              ...(courseName.trim() ? theme.shadows.glow : {}),
            }}
          />

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
      {/* mute={true} avoids AVCaptureSession audio format negotiation, which
          was failing with kAudioUnitErr_FormatNotSupported (-10868) and
          killing the session 2s after recordAsync. Golf swing clips don't
          rely on audio, so the trade-off is acceptable until the underlying
          audio session config is fixed. */}
      {isNative && CameraView ? (
        <CameraView
          ref={camera.cameraRef}
          style={StyleSheet.absoluteFillObject}
          facing="back"
          mode="video"
          videoQuality="1080p"
          mute
          // Phone torch as a "recording in progress" indicator. Cheap BLE
          // shutters don't expose their LED, so we use the rear camera
          // flash instead — visible from wherever the phone is pointed
          // (typically AT the golfer for a tripod setup). Auto-follows
          // camera.isRecording so it turns on the instant recording
          // starts and off the instant it stops.
          enableTorch={camera.isRecording}
        />
      ) : (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 16 }}>Camera Preview</Text>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 13, marginTop: 4 }}>(Available on device build)</Text>
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

      {/* End Round button — top right below overlay */}
      <Pressable
        onPress={() => {
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

      {/* Bottom controls overlay */}
      <View style={[styles.bottomControls, { paddingBottom: insets.bottom + 16 }]}>
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

          {/* Record button — large, centered */}
          <Pressable onPress={handleRecordPress} style={styles.recordButtonContainer}>
            <RecordingIndicator isRecording={camera.isRecording} />
          </Pressable>

          <Pressable onPress={handleEndHole} style={styles.actionButton}>
            <ChevronRight size={16} color={theme.colors.primary} />
            <Text style={[styles.actionButtonText, { color: theme.colors.primary }]}>
              Next Hole
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Bottom Sheets */}
      <PenaltySheet
        visible={showPenalty}
        onSelect={handlePenaltySelect}
        onDismiss={() => setShowPenalty(false)}
      />
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
  actionButtonText: {
    color: '#FF6B6B',
    fontSize: 11,
    fontWeight: '600',
  },
  recordButtonContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
