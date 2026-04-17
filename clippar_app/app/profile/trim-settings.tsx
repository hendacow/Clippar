import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Switch } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Scissors, Clock, Zap } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { getSetting, setSetting } from '@/lib/storage';

export default function TrimSettingsScreen() {
  const [autoTrimEnabled, setAutoTrimEnabled] = useState<boolean>(config.trim.autoTrimEnabled);
  const [preRollMs, setPreRollMs] = useState<number>(config.trim.defaultPreRollMs);
  const [postRollMs, setPostRollMs] = useState<number>(config.trim.defaultPostRollMs);

  // Load saved settings
  useEffect(() => {
    (async () => {
      const saved = await getSetting('trim_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.autoTrimEnabled !== undefined) setAutoTrimEnabled(parsed.autoTrimEnabled);
          if (parsed.preRollMs) setPreRollMs(parsed.preRollMs);
          if (parsed.postRollMs) setPostRollMs(parsed.postRollMs);
        } catch {}
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
    };
    await setSetting('trim_settings', JSON.stringify(current));
  }, [autoTrimEnabled, preRollMs, postRollMs]);

  const totalDuration = (preRollMs + postRollMs) / 1000;

  const PREROLL_OPTIONS = [1000, 1500, 2000, 2500, 3000, 3500, 4000];
  const POSTROLL_OPTIONS = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000];
  const DURATION_PRESETS = config.trim.durationPresets;

  return (
    <>
      <Stack.Screen options={{ title: 'Trim Settings' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        {/* Auto-trim toggle */}
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  backgroundColor: theme.colors.primary + '20',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Scissors size={18} color={theme.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                  Auto-trim
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                  Automatically detect and trim golf swings on import
                </Text>
              </View>
            </View>
            <Switch
              value={autoTrimEnabled}
              onValueChange={(val) => {
                Haptics.selectionAsync();
                setAutoTrimEnabled(val);
                save({ autoTrimEnabled: val });
              }}
              trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Duration presets */}
        <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 15, marginBottom: 8 }}>
          Auto-trim Duration
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
                onPress={() => {
                  Haptics.selectionAsync();
                  // Split duration: 40% pre, 60% post (slightly more follow-through)
                  const pre = Math.round(d * 0.4);
                  const post = d - pre;
                  setPreRollMs(pre);
                  setPostRollMs(post);
                  save({ preRollMs: pre, postRollMs: post });
                }}
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
                  onPress={() => {
                    Haptics.selectionAsync();
                    setPreRollMs(ms);
                    save({ preRollMs: ms });
                  }}
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
                  onPress={() => {
                    Haptics.selectionAsync();
                    setPostRollMs(ms);
                    save({ postRollMs: ms });
                  }}
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

        {/* Info note */}
        <Text style={{ color: theme.colors.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
          Settings apply to the next video you import.{'\n'}
          Trimming uses Apple Vision pose detection — no quality loss.
        </Text>
      </ScrollView>
    </>
  );
}
