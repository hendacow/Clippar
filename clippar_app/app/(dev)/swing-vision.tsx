/**
 * Swing-Vision dev harness — EXPERIMENTAL, dev-only.
 *
 * Runs the on-device MobileCLIP2 swing classifier (swing-vision native module)
 * over a bundled sample clip or one picked from the library, and shows the
 * per-frame class scores, the pooled decision, and REAL device latency. This
 * is the "feel the speed on your phone" screen for experiment/vision-swing-
 * classifier. Not linked from app nav — reach it via the (dev) route.
 *
 * Touches NOTHING in the live detector. If the model isn't bundled in this
 * build, the screen says so and does nothing.
 */
import { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { router, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import * as ImagePicker from 'expo-image-picker';
import { ArrowLeft, PlayCircle, FolderOpen } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import * as swingVision from 'swing-vision';
import {
  decideClip,
  VISION_CLASSES,
  type FrameScores,
} from '../../experiments/vision-swing-classifier/swingVisionLogic';

interface RunResult {
  source: string;
  frames: FrameScores[];
  elapsedMs: number;
  decision: string;
  pooled: FrameScores;
}

const SHORT: Record<string, string> = {
  full_swing: 'swing',
  address: 'addr',
  putt_chip: 'putt',
  no_shot: 'none',
};

export default function SwingVisionScreen() {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = swingVision.isAvailable();
  const loadErr = swingVision.lastError();

  const run = useCallback(async (uri: string, source: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await swingVision.classifyClip(uri, 8);
      const { label, pooled } = decideClip(out.frames);
      setResult({
        source,
        frames: out.frames,
        elapsedMs: out.elapsedMs,
        decision: label,
        pooled,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const runBundled = useCallback(
    async (mod: number, source: string) => {
      const asset = Asset.fromModule(mod);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      await run(uri, source);
    },
    [run]
  );

  const runPicked = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 1,
    });
    if (!res.canceled && res.assets[0]) {
      await run(res.assets[0].uri, 'Library clip');
    }
  }, [run]);

  return (
    <GradientBackground>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: 12 }}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 20, fontWeight: '800' }}>
            Swing Vision (experimental)
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
          {/* Availability */}
          <View
            style={{
              backgroundColor: available ? 'rgba(40,180,99,0.15)' : 'rgba(220,60,60,0.15)',
              borderColor: available ? theme.colors.primary : theme.colors.accentRed,
              borderWidth: 1,
              borderRadius: 12,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', marginBottom: 4 }}>
              {available ? 'Model loaded ✓' : 'Model NOT available'}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
              {available
                ? 'MobileCLIP2-S2 image encoder + baked text embeddings bundled.'
                : loadErr ?? 'The swing-vision native module or its model is not in this build.'}
            </Text>
          </View>

          {/* Actions */}
          <RunButton icon={<PlayCircle size={18} color="#fff" />} label="Classify sample: FULL SWING"
            disabled={busy || !available}
            onPress={() => runBundled(require('@/assets/test-videos/full_swing_sample.mp4'), 'Full-swing sample')} />
          <RunButton icon={<PlayCircle size={18} color="#fff" />} label="Classify sample: CHIP / PUTT"
            disabled={busy || !available}
            onPress={() => runBundled(require('@/assets/test-videos/chip_sample.mp4'), 'Chip sample')} />
          <RunButton icon={<FolderOpen size={18} color="#fff" />} label="Classify a clip from my library"
            disabled={busy || !available}
            onPress={runPicked} />

          {busy && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={{ color: theme.colors.textSecondary }}>Sampling frames + running Core ML…</Text>
            </View>
          )}

          {error && (
            <Text style={{ color: theme.colors.accentRed, marginTop: 16 }}>Error: {error}</Text>
          )}

          {/* Result */}
          {result && (
            <View style={{ marginTop: 20 }}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '800' }}>
                {result.source}
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                {result.frames.length} frames · {Math.round(result.elapsedMs)} ms total ·{' '}
                {Math.round(result.elapsedMs / Math.max(1, result.frames.length))} ms/frame
              </Text>

              {/* Decision */}
              <View
                style={{
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: 12,
                  padding: 14,
                  marginTop: 12,
                  borderWidth: 1,
                  borderColor: theme.colors.primary,
                }}
              >
                <Text style={{ color: theme.colors.textTertiary, fontSize: 11, letterSpacing: 1 }}>
                  DECISION
                </Text>
                <Text style={{ color: theme.colors.primary, fontSize: 26, fontWeight: '900' }}>
                  {result.decision}
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                  pooled: {VISION_CLASSES.map((c) => `${SHORT[c]} ${(result.pooled[c] * 100).toFixed(0)}%`).join('   ')}
                </Text>
              </View>

              {/* Per-frame table */}
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11, letterSpacing: 1, marginTop: 18, marginBottom: 6 }}>
                PER-FRAME SCORES
              </Text>
              <View style={{ flexDirection: 'row', paddingVertical: 4 }}>
                <Text style={{ width: 34, color: theme.colors.textTertiary, fontSize: 11 }}>#</Text>
                {VISION_CLASSES.map((c) => (
                  <Text key={c} style={{ flex: 1, color: theme.colors.textTertiary, fontSize: 11, textAlign: 'right' }}>
                    {SHORT[c]}
                  </Text>
                ))}
              </View>
              {result.frames.map((f, i) => {
                const top = VISION_CLASSES.reduce((a, b) => (f[a] >= f[b] ? a : b));
                return (
                  <View key={i} style={{ flexDirection: 'row', paddingVertical: 3, borderTopWidth: 1, borderTopColor: theme.colors.surfaceBorder }}>
                    <Text style={{ width: 34, color: theme.colors.textSecondary, fontSize: 12 }}>{i + 1}</Text>
                    {VISION_CLASSES.map((c) => (
                      <Text
                        key={c}
                        style={{
                          flex: 1,
                          fontSize: 12,
                          textAlign: 'right',
                          fontWeight: c === top ? '800' : '400',
                          color: c === top ? theme.colors.primary : theme.colors.textSecondary,
                        }}
                      >
                        {(f[c] * 100).toFixed(0)}
                      </Text>
                    ))}
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </GradientBackground>
  );
}

function RunButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.primary,
        opacity: disabled ? 0.4 : 1,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        marginBottom: 10,
      }}
    >
      {icon}
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}
