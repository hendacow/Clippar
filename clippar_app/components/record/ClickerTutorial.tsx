/**
 * ClickerTutorial — full-screen, gated, INTERACTIVE walkthrough shown when
 * a user starts a Live round. The user must physically perform each gesture
 * on their BLE clicker before the round proceeds:
 *
 *   1 click            → start recording
 *   1 click (again)    → stop recording
 *   2 clicks           → next hole
 *   3 clicks           → penalty
 *
 * This teaches the click language hands-on rather than with a static legend.
 * The real recording-screen shutter handlers are suppressed while this
 * overlay is up (see record.tsx `tutorialActive` gating) so performing the
 * gestures here doesn't actually start a recording / advance a hole.
 *
 * Escape hatches: "Skip" dismisses for this round; the "Don't show again"
 * toggle persists a global flag so it never auto-runs again (re-runnable
 * from the recording settings sheet).
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
import type { ShutterClickEvent } from '@/hooks/useShutter';

export interface ClickerTutorialStep {
  key: string;
  title: string;
  instruction: string;
  count: 1 | 2 | 3;
  icon: typeof Video;
}

const STEPS: ClickerTutorialStep[] = [
  {
    key: 'start',
    title: '1 click — Start recording',
    instruction: 'Press your clicker ONCE to start recording a shot.',
    count: 1,
    icon: Video,
  },
  {
    key: 'stop',
    title: '1 click — Stop recording',
    instruction: 'Press ONCE more to stop. (One click starts, the next stops.)',
    count: 1,
    icon: Square,
  },
  {
    key: 'next-hole',
    title: '2 clicks — Next hole',
    instruction: 'Double-click to move to the next hole.',
    count: 2,
    icon: ChevronRight,
  },
  {
    key: 'penalty',
    title: '3 clicks — Penalty',
    instruction: 'Triple-click to add a penalty stroke (no video saved).',
    count: 3,
    icon: AlertTriangle,
  },
];

export interface ClickerTutorialProps {
  /** Subscribe to debounced click events. Pass `shutter.onClick`. Returns
   *  an unsubscribe fn. */
  onClickSubscribe: (cb: (e: ShutterClickEvent) => void) => () => void;
  /** Whether a clicker is currently connected (drives the status banner). */
  connected: boolean;
  /** Fires a simulated press — used by the on-screen fallback button so
   *  users without a clicker (or testing in the simulator) can still
   *  complete the tutorial. Pass `shutter.simulatePress`. */
  onSimulatePress: () => void;
  /** Called when the user finishes all steps or taps "Start round". */
  onComplete: () => void;
  /** Called when the user skips. */
  onSkip: () => void;
  /** Called when the user toggles "Don't show again". Persisted by parent. */
  onDontShowAgainChange: (value: boolean) => void;
  dontShowAgain: boolean;
}

export function ClickerTutorial({
  onClickSubscribe,
  connected,
  onSimulatePress,
  onComplete,
  onSkip,
  onDontShowAgainChange,
  dontShowAgain,
}: ClickerTutorialProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [nudge, setNudge] = useState<string | null>(null);
  const allDone = stepIdx >= STEPS.length;

  // Keep the latest stepIdx in a ref so the (stable) click subscription
  // reads the current step without re-subscribing on every advance.
  const stepIdxRef = useRef(0);
  stepIdxRef.current = stepIdx;

  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const unsub = onClickSubscribe(({ count }) => {
      const idx = stepIdxRef.current;
      if (idx >= STEPS.length) return;
      const step = STEPS[idx];
      if (count === step.count) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setNudge(null);
        setStepIdx((i) => i + 1);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setNudge(
          `That was ${count} click${count > 1 ? 's' : ''} — this step needs ${step.count}. Try again.`
        );
        if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
        nudgeTimer.current = setTimeout(() => setNudge(null), 2500);
      }
    });
    return () => {
      unsub();
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    };
  }, [onClickSubscribe]);

  return (
    <View style={styles.overlay}>
      {/* Connection status banner */}
      <View
        style={[
          styles.banner,
          { backgroundColor: connected ? theme.colors.primaryMuted : theme.colors.surfaceElevated },
        ]}
      >
        {connected ? (
          <Bluetooth size={16} color={theme.colors.primary} />
        ) : (
          <BluetoothOff size={16} color={theme.colors.textTertiary} />
        )}
        <Text
          style={{
            color: connected ? theme.colors.primary : theme.colors.textSecondary,
            fontSize: 13,
            fontWeight: '600',
            flex: 1,
          }}
        >
          {connected
            ? 'Clicker connected'
            : 'No clicker yet — pair it in iOS Settings › Bluetooth, or use the button below.'}
        </Text>
      </View>

      <View style={styles.body}>
        <Text style={styles.heading}>
          {allDone ? "You're all set!" : 'Test your clicker'}
        </Text>
        <Text style={styles.subheading}>
          {allDone
            ? 'That’s the whole click language. Tap below to start your round.'
            : 'Run through each control once. You’ll do these for real during your round.'}
        </Text>

        {/* Step checklist */}
        <View style={{ gap: 10, marginTop: 24, width: '100%' }}>
          {STEPS.map((step, i) => {
            const done = i < stepIdx;
            const active = i === stepIdx;
            const Icon = step.icon;
            return (
              <View
                key={step.key}
                style={[
                  styles.stepRow,
                  {
                    borderColor: active
                      ? theme.colors.primary
                      : theme.colors.surfaceBorder,
                    backgroundColor: active
                      ? theme.colors.primaryMuted
                      : theme.colors.surface,
                    opacity: done || active ? 1 : 0.5,
                  },
                ]}
              >
                <View
                  style={[
                    styles.stepIconWrap,
                    {
                      backgroundColor: done
                        ? theme.colors.primary
                        : theme.colors.surfaceElevated,
                    },
                  ]}
                >
                  {done ? (
                    <Check size={16} color="#fff" />
                  ) : active ? (
                    <Icon size={16} color={theme.colors.primary} />
                  ) : (
                    <Circle size={16} color={theme.colors.textTertiary} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: theme.colors.textPrimary,
                      fontWeight: '700',
                      fontSize: 14,
                    }}
                  >
                    {step.title}
                  </Text>
                  {active && (
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 12,
                        marginTop: 2,
                      }}
                    >
                      {step.instruction}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>

        {/* Nudge on wrong click count */}
        {nudge && (
          <Text style={styles.nudge}>{nudge}</Text>
        )}

        {/* Fallback: simulate the current step's gesture (no clicker /
            simulator). Fires the required number of presses in quick
            succession; they accumulate into one debounced click event with
            the right count. */}
        {!allDone && (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              const need = STEPS[stepIdxRef.current]?.count ?? 1;
              for (let i = 0; i < need; i++) onSimulatePress();
            }}
            style={styles.simulateBtn}
          >
            <Text style={styles.simulateText}>
              No clicker? Tap to simulate this step
            </Text>
          </Pressable>
        )}
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        {allDone ? (
          <Button title="Start round" onPress={onComplete} />
        ) : (
          <>
            <Pressable
              onPress={() => onDontShowAgainChange(!dontShowAgain)}
              style={styles.dontShowRow}
              hitSlop={8}
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
                {dontShowAgain && <Check size={12} color="#fff" />}
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                Don't show this again
              </Text>
            </Pressable>
            <Pressable onPress={onSkip} hitSlop={8} style={{ paddingVertical: 8 }}>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 14,
                  fontWeight: '600',
                  textAlign: 'center',
                }}
              >
                Skip for now
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    zIndex: 50,
    paddingHorizontal: 24,
    justifyContent: 'space-between',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    marginTop: 60,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heading: {
    color: theme.colors.textPrimary,
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
  },
  subheading: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
    paddingHorizontal: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  stepIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nudge: {
    color: theme.colors.bogey,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 18,
  },
  simulateBtn: {
    marginTop: 24,
    paddingVertical: 8,
  },
  simulateText: {
    color: theme.colors.textTertiary,
    fontSize: 13,
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
  footer: {
    paddingBottom: 40,
    gap: 4,
  },
  dontShowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.colors.surfaceBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
