import { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable, Alert, Platform, StyleSheet } from 'react-native';
import { router, useNavigation } from 'expo-router';
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
} from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { RecordingIndicator } from '@/components/record/RecordingIndicator';
import { ScoreOverlay } from '@/components/record/ScoreOverlay';
import { PenaltySheet } from '@/components/record/PenaltySheet';
import { CameraPermissionScreen } from '@/components/record/CameraPermissionScreen';
import { CourseSearch } from '@/components/record/CourseSearch';
import { useBLE } from '@/hooks/useBLE';
import { useShutter } from '@/hooks/useShutter';
import { useRound } from '@/hooks/useRound';
import { useCamera } from '@/hooks/useCamera';
import { useLocation } from '@/hooks/useLocation';
import { getOrphanedRounds } from '@/lib/storage';
import { useUploadContext } from '@/contexts/UploadContext';
import type { PenaltyType, ClipMetadata, HoleData } from '@/types/round';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const DEFAULT_PAR = 4;

// Conditionally import CameraView for native
const CameraView = isNative
  ? (require('expo-camera') as typeof import('expo-camera')).CameraView
  : null;

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const ble = useBLE();
  const shutter = useShutter();
  const round = useRound();
  const { startUpload } = useUploadContext();
  const { getCurrentLocation } = useLocation();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[] | undefined>();
  const [showPenalty, setShowPenalty] = useState(false);
  const [orphanedRound, setOrphanedRound] = useState<{ id: string; course_name: string } | null>(null);

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
  });

  // Hide tab bar during active recording
  useEffect(() => {
    if (isActive) {
      navigation.setOptions({ tabBarStyle: { display: 'none' } });
    } else {
      navigation.setOptions({ tabBarStyle: undefined });
    }
  }, [isActive, navigation]);

  // Subscribe shutter press (BLE or volume button) to camera toggle
  useEffect(() => {
    if (!isActive) return;

    const unsubscribe = shutter.onPress(() => {
      if (isNative) {
        camera.toggleRecording();
      } else {
        camera.simulateRecording();
      }
    });

    return unsubscribe;
  }, [shutter.onPress, isActive, camera.toggleRecording, camera.simulateRecording]);

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

  const startRound = async () => {
    if (!courseName.trim()) {
      Alert.alert('Course Name', 'Please enter or select a course to start.');
      return;
    }
    await round.startRound(courseName.trim(), selectedCourseId, courseHoles);
  };

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

  // ---- IDLE STATE: Course Selection ----
  if (!roundState || roundState.status === 'not_started') {
    return (
      <GradientBackground>
        <View style={{ flex: 1, paddingTop: insets.top, padding: 24 }}>
          <Text style={{ ...theme.typography.h1, color: theme.colors.textPrimary, marginBottom: 8 }}>
            Record
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.textSecondary, marginBottom: 24 }}>
            Pick your course and you're ready to go.
          </Text>

          {/* Orphaned round recovery */}
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

          {/* Course Search */}
          <CourseSearch
            value={courseName}
            onChangeText={setCourseName}
            onSelectCourse={handleCourseSelect}
          />

          <Button
            title="Start Round"
            onPress={startRound}
            style={{
              marginTop: 24,
              ...(courseName.trim() ? theme.shadows.glow : {}),
            }}
          />

          <Pressable
            onPress={() => router.push('/round/import')}
            style={{
              marginTop: 16,
              paddingVertical: 14,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <Film size={18} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.primary, fontWeight: '600', fontSize: 15 }}>
              Import Round from Camera Roll
            </Text>
          </Pressable>

          {/* Dev: Simulate BLE press */}
          {__DEV__ && (
            <Button
              title="[DEV] Simulate Shutter Press"
              onPress={shutter.simulatePress}
              variant="ghost"
              style={{ marginTop: 16 }}
            />
          )}
        </View>
      </GradientBackground>
    );
  }

  // ---- FINISHED STATE ----
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
            title="Upload & Process"
            onPress={() => {
              round.endRound();
              startUpload(roundState.roundId, roundState.courseName);
              round.resetRound();
              setCourseName('');
              router.replace('/(tabs)');
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
      {isNative && CameraView ? (
        <CameraView
          ref={camera.cameraRef}
          style={StyleSheet.absoluteFillObject}
          facing="back"
          mode="video"
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
