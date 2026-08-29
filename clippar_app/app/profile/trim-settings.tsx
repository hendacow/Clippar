import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Clock, Zap } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  config,
  resolveSavedTrimWindow,
  splitDurationPreset,
  TRIM_WINDOW_MARKER,
} from '@/constants/config';
import { getSetting, setSetting } from '@/lib/storage';

/**
 * Trim Settings — how much of each swing is kept, before and after impact.
 *
 * EVERY CONTROL ON THIS SCREEN WRITES TRIM_WINDOW_MARKER, and the initial values
 * come back through resolveSavedTrimWindow, the same resolver hooks/useCamera
 * and hooks/useEditorState trim with. Both halves are load-bearing:
 *
 *  - Without the marker on save, hooks/useCamera.loadTrimSettings and
 *    hooks/useEditorState.getTrimSettings discard the override as a pre-FIX-#8
 *    leftover. That was the bug: the pickers and presets saved happily, showed
 *    the new length, and every clip still trimmed to 2500/1500.
 *  - Without the shared resolver on load, this screen shows a length the
 *    pipeline does not use. It previously seeded from config.trim.defaultPre/
 *    PostRollMs (3000/2000) and opened claiming 5.0s clips that never existed.
 *
 * See constants/config.ts for the full history of the guard.
 *
 * The "Auto-trim" switch that used to sit at the top of this screen is gone —
 * nothing read it, and nothing safely could. Rationale lives with the removed
 * config.trim.autoTrimEnabled field.
 */
export default function TrimSettingsScreen() {
  // Day-zero values are the window the pipeline actually falls back to, not the
  // legacy "defaults" — so a first-run screen matches a first-run trim.
  const [preRollMs, setPreRollMs] = useState<number>(config.trim.windows.fullSwing.preRollMs);
  const [postRollMs, setPostRollMs] = useState<number>(config.trim.windows.fullSwing.postRollMs);

  // Load saved settings through the readers' own resolver, so what is on screen
  // is what the next clip will be trimmed to — including the case where a stale
  // untagged override exists and is (correctly) ignored by both.
  useEffect(() => {
    (async () => {
      try {
        const saved = await getSetting('trim_settings');
        const window = resolveSavedTrimWindow(saved);
        setPreRollMs(window.preRollMs);
        setPostRollMs(window.postRollMs);
      } catch {
        // Keep the config window already in state.
      }
    })();
  }, []);

  // Save settings on change
  const save = useCallback(async (updates: Record<string, any>) => {
    const current = {
      autoTrimEnabled,
      preRollMs,
      postRollMs,
      ...updates,
      // Marker so the trim hooks honor this override as a full-swing window
      // (otherwise the override is ignored to avoid shadowing the default window).
      window: 'fullSwing',
    };
    await setSetting('trim_settings', JSON.stringify(current));
  }, [autoTrimEnabled, preRollMs, postRollMs]);

  const totalDuration = (preRollMs + postRollMs) / 1000;

  const PREROLL_OPTIONS = config.trim.preRollOptionsMs;
  const POSTROLL_OPTIONS = config.trim.postRollOptionsMs;
  const DURATION_PRESETS = config.trim.durationPresets;

  return (
    <>
      <Stack.Screen options={{ title: 'Trim Settings' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        {/* Duration presets */}
        <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 15, marginBottom: 8 }}>
          Clip Length
        </Text>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
          Total clip length after trimming. Currently: {totalDuration.toFixed(1)}s
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
          {DURATION_PRESETS.map((d) => {
            const isActive = Math.abs(preRollMs + postRollMs - d) < 200;
            return (
              <Pressable
                key={d}
                onPress={() => applyWindow(splitDurationPreset(d))}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: theme.radius.md,
                  backgroundColor: isActive ? theme.colors.textPrimary : theme.colors.surfaceElevated,
                  borderWidth: 1,
                  borderColor: isActive ? theme.colors.textPrimary : theme.colors.surfaceBorder,
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    color: isActive ? theme.colors.background : theme.colors.textPrimary,
                    fontWeight: '700',
                    fontSize: 15,
                  }}
                >
                  {d / 1000}s
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Pre-impact time */}
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                backgroundColor: '#2196F320',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Clock size={18} color="#2196F3" />
            </View>
            <View>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                Before Impact
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                {(preRollMs / 1000).toFixed(1)}s before impact
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {PREROLL_OPTIONS.map((ms) => {
              const isActive = preRollMs === ms;
              return (
                <Pressable
                  key={ms}
                  onPress={() => applyWindow({ preRollMs: ms, postRollMs })}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: theme.radius.sm,
                    backgroundColor: isActive ? theme.colors.primary : theme.colors.surface,
                    borderWidth: 1,
                    borderColor: isActive ? theme.colors.primary : theme.colors.surfaceBorder,
                  }}
                >
                  <Text
                    style={{
                      color: isActive ? '#fff' : theme.colors.textPrimary,
                      fontWeight: '600',
                      fontSize: 13,
                    }}
                  >
                    {(ms / 1000).toFixed(1)}s
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Post-impact time */}
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                backgroundColor: '#FF990020',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Zap size={18} color="#FF9900" />
            </View>
            <View>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                After Impact
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                {(postRollMs / 1000).toFixed(1)}s after impact
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {POSTROLL_OPTIONS.map((ms) => {
              const isActive = postRollMs === ms;
              return (
                <Pressable
                  key={ms}
                  onPress={() => applyWindow({ preRollMs, postRollMs: ms })}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: theme.radius.sm,
                    backgroundColor: isActive ? theme.colors.primary : theme.colors.surface,
                    borderWidth: 1,
                    borderColor: isActive ? theme.colors.primary : theme.colors.surfaceBorder,
                  }}
                >
                  <Text
                    style={{
                      color: isActive ? '#fff' : theme.colors.textPrimary,
                      fontWeight: '600',
                      fontSize: 13,
                    }}
                  >
                    {(ms / 1000).toFixed(1)}s
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Info note. "Next" is exact, not a hedge: both readers resolve this
            window when a clip is first processed, so shots already recorded or
            imported keep the length they were trimmed at. Changing these
            settings can never go back and shorten footage you already have. */}
        <Text style={{ color: theme.colors.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
          Applies to the next shot you record or import.{'\n'}
          Clips already trimmed keep their current length.{'\n'}
          Trimming uses Apple Vision pose detection — no quality loss.
        </Text>
      </ScrollView>
    </>
  );
}
