/**
 * ClickerTutorial — a LIVE, non-blocking coaching layer over the real
 * recording screen. The user practices the clicker on the actual round so
 * they SEE recording start/stop, the hole change, and a penalty get applied
 * — but the round runs in "practice" mode (camera discards clips) and is
 * reset to a clean slate the moment the tutorial finishes (see record.tsx
 * `round.resetToStart`).
 *
 * Rather than intercept clicks, this component OBSERVES the real round/camera
 * state and ticks off each capability as it actually happens:
 *   • start recording  → camera.isRecording went true
 *   • stop recording   → camera.isRecording went false (after starting)
 *   • next hole        → currentHole increased
 *   • penalty          → penaltyCount increased
 *
 * It renders as a floating card (the wrapper is pointerEvents="box-none" so
 * the bottom record controls underneath stay usable). When all four are
 * done it offers "Start round".
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  Bluetooth,
  BluetoothOff,
  Check,
  Circle,
  Video,
  Square,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Button } from '@/components/ui/Button';

type StepKey = 'start' | 'stop' | 'next-hole' | 'penalty';

interface StepMeta {
  key: StepKey;
  title: string;
  instruction: string;
  icon: typeof Video;
}

const STEPS: StepMeta[] = [
  {
    key: 'start',
    title: 'Start recording',
    instruction: 'Click your clicker ONCE to start recording a shot.',
    icon: Video,
  },
  {
    key: 'stop',
    title: 'Stop recording',
    instruction: 'Click ONCE more to stop. (One click starts, the next stops.)',
    icon: Square,
  },
  {
    key: 'next-hole',
    title: 'Next hole',
    instruction: 'Double-click to move to the next hole — watch the hole number.',
    icon: ChevronRight,
  },
  {
    key: 'penalty',
    title: 'Penalty',
    instruction: 'Triple-click to add a penalty stroke (no video saved).',
    icon: AlertTriangle,
  },
];

export interface ClickerTutorialProps {
  /**
   * 'intro'    — blocking choice card: practise, or go straight to playing.
   *              Nothing underneath is pressable, so the user can never be
   *              unknowingly in practice mode (where clips are discarded).
   * 'coaching' — the live, non-blocking coach. Clips ARE discarded here, on
   *              purpose, and the round is reset when it ends.
   */
  phase: 'intro' | 'coaching';
  /** Intro card: user chose to practise. */
  onStartPractice: () => void;
  /** Live recording state (camera.isRecording). */
  isRecording: boolean;
  /** Live current hole number (round.state.currentHole). */
  currentHole: number;
  /** Monotonic counter the parent bumps each time a penalty is applied. */
  penaltyCount: number;
  /** Clicker connection status (drives the banner). */
  connected: boolean;
  /** All four steps done OR user tapped "Start round". */
  onFinish: () => void;
  /** User skipped. */
  onSkip: () => void;
  dontShowAgain: boolean;
  onDontShowAgainChange: (value: boolean) => void;
}

export function ClickerTutorial({
  phase,
  onStartPractice,
  isRecording,
  currentHole,
  penaltyCount,
  connected,
  onFinish,
  onSkip,
  dontShowAgain,
  onDontShowAgainChange,
}: ClickerTutorialProps) {
  const [done, setDone] = useState<Record<StepKey, boolean>>({
    start: false,
    stop: false,
    'next-hole': false,
    penalty: false,
  });

  // Baselines captured once so we detect CHANGES from the moment the
  // tutorial appeared, not absolute values.
  const initialHoleRef = useRef(currentHole);
  const initialPenaltyRef = useRef(penaltyCount);
  const wasRecordingRef = useRef(isRecording);

  // Detect start / stop from isRecording transitions.
  useEffect(() => {
    setDone((d) => {
      if (isRecording && !wasRecordingRef.current) {
        wasRecordingRef.current = isRecording;
        return d.start ? d : { ...d, start: true };
      }
      if (!isRecording && wasRecordingRef.current) {
        wasRecordingRef.current = isRecording;
        // Stopping only counts once we've recorded at least once.
        return d.start && !d.stop ? { ...d, stop: true } : d;
      }
      wasRecordingRef.current = isRecording;
      return d;
    });
  }, [isRecording]);

  // Detect a hole CHANGE (either direction). Requiring an increase meant that
  // pressing Previous Hole during practice could push the hole back to (or
  // below) the baseline, after which the step could never complete and the
  // card stayed up indefinitely.
  useEffect(() => {
    if (currentHole !== initialHoleRef.current) {
      setDone((d) => (d['next-hole'] ? d : { ...d, 'next-hole': true }));
    }
  }, [currentHole]);

  // Detect penalty.
  useEffect(() => {
    if (penaltyCount > initialPenaltyRef.current) {
      setDone((d) => (d.penalty ? d : { ...d, penalty: true }));
    }
  }, [penaltyCount]);

  // Success haptic whenever the number of completed steps increases.
  const doneCount = STEPS.filter((s) => done[s.key]).length;
  const prevDoneCountRef = useRef(0);
  useEffect(() => {
    if (doneCount > prevDoneCountRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevDoneCountRef.current = doneCount;
  }, [doneCount]);

  const allDone = doneCount === STEPS.length;
  // The active step is the first not-yet-done one (drives the headline).
  const activeStep = STEPS.find((s) => !done[s.key]) ?? null;

  // ── Intro: blocking choice ────────────────────────────────────────────────
  // The scrim swallows every touch, so the record button / hole controls
  // underneath cannot fire while this is up.
  if (phase === 'intro') {
    return (
      <View style={[styles.wrapper, styles.scrim]} pointerEvents="auto">
        <View style={[styles.card, { marginTop: 0 }]} pointerEvents="auto">
          <View style={styles.headerRow}>
            <View style={styles.practiceBadge}>
              <Text style={styles.practiceBadgeText}>BEFORE YOU TEE OFF</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {connected ? (
                <Bluetooth size={12} color={theme.colors.primary} />
              ) : (
                <BluetoothOff size={12} color={theme.colors.textTertiary} />
              )}
              <Text
                style={{
                  color: connected ? theme.colors.primary : theme.colors.textTertiary,
                  fontSize: 11,
                  fontWeight: '600',
                }}
              >
                {connected ? 'Clicker connected' : 'No clicker'}
              </Text>
            </View>
          </View>

          <Text style={styles.headline}>Practise the clicker?</Text>
          <Text style={styles.instruction}>
            A quick run-through of the four clicker actions. Nothing you record
            during practice is saved, and your round resets to the start when
            you finish.
          </Text>

          <Button
            title="Practise first"
            onPress={onStartPractice}
            style={{ marginTop: 16 }}
          />

          <Pressable onPress={onSkip} hitSlop={8} style={{ marginTop: 14 }}>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 14,
                fontWeight: '700',
                textAlign: 'center',
              }}
            >
              No — start recording for real
            </Text>
          </Pressable>

          <Pressable
            onPress={() => onDontShowAgainChange(!dontShowAgain)}
            hitSlop={8}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              marginTop: 16,
            }}
          >
            <View
              style={[
                styles.checkbox,
                dontShowAgain && {
                  backgroundColor: theme.colors.primary,
                  borderColor: theme.colors.primary,
                },
              ]}
            >
              {dontShowAgain && <Check size={11} color="#fff" />}
            </View>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
              Don't ask again
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      <View style={styles.card} pointerEvents="auto">
        {/* Header row: PRACTICE badge + connection */}
        <View style={styles.headerRow}>
          <View style={styles.practiceBadge}>
            <Text style={styles.practiceBadgeText}>PRACTICE</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {connected ? (
              <Bluetooth size={12} color={theme.colors.primary} />
            ) : (
              <BluetoothOff size={12} color={theme.colors.textTertiary} />
            )}
            <Text
              style={{
                color: connected ? theme.colors.primary : theme.colors.textTertiary,
                fontSize: 11,
                fontWeight: '600',
              }}
            >
              {connected ? 'Clicker connected' : 'No clicker'}
            </Text>
          </View>
        </View>

        {/* Headline / active instruction */}
        <Text style={styles.headline}>
          {allDone ? "You've got it!" : activeStep?.title}
        </Text>
        <Text style={styles.instruction}>
          {allDone
            ? 'Nothing you just did was saved — your round starts fresh.'
            : activeStep?.instruction}
        </Text>

        {/* Step pips */}
        <View style={styles.pips}>
          {STEPS.map((s) => {
            const isDone = done[s.key];
            const isActive = activeStep?.key === s.key;
            const Icon = s.icon;
            return (
              <View
                key={s.key}
                style={[
                  styles.pip,
                  {
                    borderColor: isActive
                      ? theme.colors.primary
                      : theme.colors.surfaceBorder,
                    backgroundColor: isDone
                      ? theme.colors.primary
                      : 'rgba(0,0,0,0.4)',
                  },
                ]}
              >
                {isDone ? (
                  <Check size={14} color="#fff" />
                ) : isActive ? (
                  <Icon size={14} color={theme.colors.primary} />
                ) : (
                  <Circle size={14} color={theme.colors.textTertiary} />
                )}
              </View>
            );
          })}
        </View>

        {/* Footer */}
        {allDone ? (
          <Button title="Start round" onPress={onFinish} style={{ marginTop: 14 }} />
        ) : (
          <View style={styles.footerRow}>
            <Pressable
              onPress={() => onDontShowAgainChange(!dontShowAgain)}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <View
                style={[
                  styles.checkbox,
                  dontShowAgain && {
                    backgroundColor: theme.colors.primary,
                    borderColor: theme.colors.primary,
                  },
                ]}
              >
                {dontShowAgain && <Check size={11} color="#fff" />}
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                Don't show again
              </Text>
            </Pressable>
            <Pressable onPress={onSkip} hitSlop={8}>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 13,
                  fontWeight: '700',
                }}
              >
                Skip
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Covers the screen but lets touches fall through to the recording
  // controls underneath — only the card itself is interactive.
  wrapper: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-start',
    alignItems: 'center',
    zIndex: 40,
  },
  // Intro phase only: dims and, more importantly, absorbs all touches.
  scrim: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
  },
  card: {
    marginTop: 150,
    width: '88%',
    backgroundColor: 'rgba(10,10,15,0.92)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 18,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  practiceBadge: {
    backgroundColor: theme.colors.accentGold,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  practiceBadgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headline: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '800',
  },
  instruction: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  pips: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  pip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: theme.colors.surfaceBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
