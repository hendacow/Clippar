/**
 * Swing-Vision dev harness — EXPERIMENTAL, dev-only.
 *
 * Runs the on-device swing LOCALIZER over a clip from the library and shows the
 * second it thinks the swing happened, so you can scrub the original clip to
 * that timestamp and check it. Also lists every candidate it considered, which
 * is what you need when it gets one wrong: it tells you whether the right
 * moment was found and mis-ranked, or never found at all.
 *
 * Touches NOTHING in the live detector. If the model isn't bundled in this
 * build, the screen says so and does nothing.
 */
import { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { router, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ArrowLeft, FolderOpen } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import * as swingVision from 'swing-vision';
import { trimVideo } from 'shot-detector';

interface RunResult extends swingVision.LocalizeResult {
  source: string;
  /** What actually plays below: the 5s highlight, or the untouched original. */
  playbackUri: string;
  plan: swingVision.TrimPlan;
  trimMs: number;
}

export default function SwingVisionScreen() {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = swingVision.isAvailable();
  const nativePresent = swingVision.isNativeModulePresent();
  const loadErr = swingVision.lastError();
  // Distinguish the two failure modes so the cause is unambiguous on device.
  const diagnostic = !nativePresent
    ? 'Native module did NOT link into this build.'
    : loadErr ?? 'Model/prototypes failed to load (no error reported).';

  // The trimmed highlight (or the untouched original) plays here. expo-video
  // rebuilds the player when the source changes, so passing state is enough.
  const player = useVideoPlayer(result?.playbackUri ?? null, (p) => {
    p.loop = true;
    p.play();
  });

  const runPicked = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 1,
    });
    if (res.canceled || !res.assets[0]) return;
    const uri = res.assets[0].uri;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await swingVision.localizeSwing(uri);
      const plan = swingVision.planHighlightTrim(out);
      let playbackUri = uri;
      let trimMs = 0;
      if (plan.trim) {
        // Passthrough trim — no re-encode, so 4K stays 4K and this is sub-second.
        const t0 = Date.now();
        const trimmed = await trimVideo(uri, plan.startSec * 1000, plan.endSec * 1000);
        trimMs = Date.now() - t0;
        playbackUri = trimmed.trimmedUri ?? uri;
      }
      setResult({
        ...out,
        source: res.assets[0].fileName ?? 'Library clip',
        playbackUri,
        plan,
        trimMs,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <GradientBackground>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: 12 }}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 20, fontWeight: '800' }}>
            Swing Vision (experimental)
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
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
              {available ? 'Localizer loaded ✓' : 'Localizer NOT available'}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
              {available
                ? 'Motion finds the instant; Core ML judges ~6 candidates against image prototypes.'
                : diagnostic}
            </Text>
          </View>

          <Pressable
            onPress={runPicked}
            disabled={busy || !available}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              backgroundColor: theme.colors.primary,
              opacity: busy || !available ? 0.4 : 1,
              borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 10,
            }}
          >
            <FolderOpen size={18} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
              Find the swing in a clip from my library
            </Text>
          </Pressable>

          {busy && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={{ color: theme.colors.textSecondary }}>
                Scanning motion, then checking candidates…
              </Text>
            </View>
          )}

          {error && <Text style={{ color: theme.colors.accentRed, marginTop: 16 }}>Error: {error}</Text>}

          {result && (
            <View style={{ marginTop: 20 }}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '800' }}>
                {result.source}
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                {Math.round(result.elapsedMs)} ms total · motion at {result.motionFps.toFixed(0)} fps ·{' '}
                {result.candidates.length} candidates
              </Text>

              <View
                style={{
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: 12, padding: 16, marginTop: 12,
                  borderWidth: 1,
                  borderColor: result.decision === 'SWING' ? theme.colors.primary : theme.colors.accentRed,
                }}
              >
                {result.decision === 'SWING' && result.tTop !== undefined ? (
                  <>
                    <Text style={{ color: theme.colors.textTertiary, fontSize: 11, letterSpacing: 1 }}>
                      {result.strokeType === 'putt' ? 'PUTTING STROKE AT' : 'TOP OF SWING AT'}
                    </Text>
                    <Text style={{ color: theme.colors.primary, fontSize: 42, fontWeight: '900' }}>
                      {result.tTop.toFixed(2)}s
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
                      impact {result.tImpact!.toFixed(2)}s   (downswing{' '}
                      {(result.tImpact! - result.tTop).toFixed(2)}s — expect ~0.20s)
                    </Text>
                    <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 8 }}>
                      Scrub the clip to {result.tTop.toFixed(2)}s to check it.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={{ color: theme.colors.accentRed, fontSize: 26, fontWeight: '900' }}>
                      NO SWING FOUND
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 }}>
                      Nothing in this clip looked like a golfer striking the ball.
                    </Text>
                  </>
                )}
              </View>

              {/* The result you actually care about: what a user would end up
                  watching. Trimmed to 5s for a swing; untouched for a putt or
                  when nothing was found. */}
              <View
                style={{
                  marginTop: 16, borderRadius: 12, overflow: 'hidden',
                  borderWidth: 1, borderColor: theme.colors.surfaceBorder,
                  backgroundColor: '#000',
                }}
              >
                <VideoView
                  player={player}
                  style={{ width: '100%', aspectRatio: 9 / 16, maxHeight: 420 }}
                  contentFit="contain"
                  nativeControls
                />
              </View>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  marginTop: 8, paddingHorizontal: 2,
                }}
              >
                <View
                  style={{
                    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                    backgroundColor: result.plan.trim
                      ? 'rgba(40,180,99,0.22)'
                      : 'rgba(255,255,255,0.10)',
                  }}
                >
                  <Text
                    style={{
                      color: result.plan.trim ? theme.colors.primary : theme.colors.textSecondary,
                      fontSize: 11, fontWeight: '800', letterSpacing: 0.5,
                    }}
                  >
                    {result.plan.trim
                      ? `TRIMMED ${result.plan.startSec.toFixed(2)}–${result.plan.endSec.toFixed(2)}s`
                      : 'UNCHANGED'}
                  </Text>
                </View>
                <Text style={{ color: theme.colors.textTertiary, fontSize: 12, flex: 1 }}>
                  {result.plan.reason}
                  {result.trimMs > 0 ? `  (${result.trimMs} ms)` : ''}
                </Text>
              </View>

              {/* Candidates: when it is wrong, this says whether the right moment
                  was found and mis-ranked, or never found at all. */}
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11, letterSpacing: 1, marginTop: 18, marginBottom: 6 }}>
                CANDIDATES CONSIDERED
              </Text>
              <View style={{ flexDirection: 'row', paddingVertical: 4 }}>
                {['#', 'top', 'impact', 'motion', 'proto'].map((h, i) => (
                  <Text
                    key={h}
                    style={{
                      width: i === 0 ? 28 : undefined,
                      flex: i === 0 ? undefined : 1,
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                      textAlign: i === 0 ? 'left' : 'right',
                    }}
                  >
                    {h}
                  </Text>
                ))}
              </View>
              {result.candidates.map((c, i) => {
                const picked =
                  result.tTop !== undefined && Math.abs(c.tTop - result.tTop) < 1e-6;
                return (
                  <View
                    key={i}
                    style={{
                      flexDirection: 'row',
                      paddingVertical: 4,
                      borderTopWidth: 1,
                      borderTopColor: theme.colors.surfaceBorder,
                      backgroundColor: picked ? 'rgba(40,180,99,0.12)' : 'transparent',
                    }}
                  >
                    <Text style={{ width: 28, color: theme.colors.textSecondary, fontSize: 12 }}>
                      {i + 1}
                    </Text>
                    {[
                      `${c.tTop.toFixed(2)}s`,
                      `${c.tImpact.toFixed(2)}s`,
                      c.norm.toFixed(2),
                      c.proto >= 0 ? `+${c.proto.toFixed(3)}` : c.proto.toFixed(3),
                    ].map((v, j) => (
                      <Text
                        key={j}
                        style={{
                          flex: 1,
                          fontSize: 12,
                          textAlign: 'right',
                          fontWeight: picked ? '800' : '400',
                          color: picked ? theme.colors.primary : theme.colors.textSecondary,
                        }}
                      >
                        {v}
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
