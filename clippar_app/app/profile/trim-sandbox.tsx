/**
 * Trim Sandbox — pick a video from Photos, run detectAndTrim against it
 * directly, and see the raw native result on screen. Avoids the full
 * round-import round-trip when iterating on trim/auto-trim bugs.
 *
 * Output is a JSON dump you can copy to chat for diagnosis. It also
 * shows the trimmed file's playable preview so you can confirm whether
 * the trim window matches the actual swing impact in the source video.
 */
import { useState, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Platform, Share } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Play, Copy, RefreshCw } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { detectAndTrim, type DetectAndTrimResult } from 'shot-detector';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const ImagePicker = isNative
  ? (require('expo-image-picker') as typeof import('expo-image-picker'))
  : null;
const ExpoVideo = isNative
  ? (require('expo-video') as typeof import('expo-video'))
  : null;

type RunRow = {
  id: number;
  sourceUri: string;
  sourceDurationMs?: number;
  result?: DetectAndTrimResult;
  error?: string;
  elapsedMs: number;
};

export default function TrimSandboxScreen() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const player = ExpoVideo && previewUri
    ? ExpoVideo.useVideoPlayer(previewUri, (p) => {
        p.loop = true;
        p.play();
      })
    : null;

  const pickAndRun = useCallback(async () => {
    if (!ImagePicker) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setRunning(true);
    const id = Date.now();
    const startedAt = Date.now();
    const baseRow: RunRow = {
      id,
      sourceUri: asset.uri,
      sourceDurationMs: asset.duration ?? undefined,
      elapsedMs: 0,
    };
    setRuns((prev) => [baseRow, ...prev]);

    try {
      // Default trim settings: 2000ms pre-roll, 3000ms post-roll
      const r = await detectAndTrim(asset.uri, 2000, 3000, []);
      const elapsed = Date.now() - startedAt;
      setRuns((prev) =>
        prev.map((row) => (row.id === id ? { ...row, result: r, elapsedMs: elapsed } : row)),
      );
      if (r.trimmedUri) setPreviewUri(r.trimmedUri);
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      setRuns((prev) =>
        prev.map((row) =>
          row.id === id
            ? { ...row, error: err instanceof Error ? err.message : String(err), elapsedMs: elapsed }
            : row,
        ),
      );
    } finally {
      setRunning(false);
    }
  }, []);

  const copyAll = useCallback(async () => {
    const dump = runs.map((r) => ({
      sourceUri: r.sourceUri.slice(-60),
      sourceDurationMs: r.sourceDurationMs,
      elapsedMs: r.elapsedMs,
      ...(r.error ? { error: r.error } : {}),
      ...(r.result
        ? {
            found: r.result.found,
            shotType: r.result.shotType,
            confidence: r.result.confidence,
            impactTimeMs: r.result.impactTimeMs,
            trimStartMs: r.result.trimStartMs,
            trimEndMs: r.result.trimEndMs,
            trimWindowMs:
              typeof r.result.trimEndMs === 'number' && typeof r.result.trimStartMs === 'number'
                ? r.result.trimEndMs - r.result.trimStartMs
                : null,
            trimmedFileCreated: !!r.result.trimmedUri,
            trimmedUri: r.result.trimmedUri?.slice(-60) ?? null,
          }
        : {}),
    }));
    const text = JSON.stringify(dump, null, 2);
    await Share.share({ message: text });
  }, [runs]);

  return (
    <>
      <Stack.Screen options={{ title: 'Trim Sandbox' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
      >
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
          Pick a single video. Auto-trim runs immediately on it (no round
          needed). Results show below. Tap copy to share the JSON dump.
        </Text>

        {/* Pick + Run button */}
        <Pressable
          onPress={pickAndRun}
          disabled={running}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            paddingVertical: 14,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.primary,
            opacity: pressed || running ? 0.6 : 1,
            marginBottom: 12,
          })}
        >
          <Play size={16} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>
            {running ? 'Running detectAndTrim…' : 'Pick video + run trim'}
          </Text>
        </Pressable>

        {/* Preview of the most recent trimmed clip */}
        {previewUri && ExpoVideo && player && (
          <View
            style={{
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              padding: 8,
              marginBottom: 16,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginBottom: 6 }}>
              Most recent trim file (looping)
            </Text>
            <ExpoVideo.VideoView
              player={player as any}
              style={{ width: 220, aspectRatio: 9 / 16, borderRadius: theme.radius.md }}
              contentFit="contain"
            />
          </View>
        )}

        {/* Action buttons */}
        {runs.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            <Pressable
              onPress={copyAll}
              style={({ pressed }) => ({
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 10,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Copy size={14} color={theme.colors.textPrimary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
                Share JSON
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setRuns([])}
              style={({ pressed }) => ({
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 10,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                backgroundColor: theme.colors.surfaceElevated,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <RefreshCw size={14} color={theme.colors.textPrimary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
                Clear
              </Text>
            </Pressable>
          </View>
        )}

        {/* Per-run results */}
        {runs.map((row) => (
          <View
            key={row.id}
            style={{
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <Text style={{ color: theme.colors.textTertiary, fontSize: 11, marginBottom: 6 }}>
              ...{row.sourceUri.slice(-50)}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginBottom: 6 }}>
              source duration: {row.sourceDurationMs ? `${row.sourceDurationMs}ms` : 'unknown'}
              {' · '}
              elapsed: {row.elapsedMs}ms
            </Text>
            {row.error && (
              <Text style={{ color: theme.colors.doubleBogey, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
                ERROR: {row.error}
              </Text>
            )}
            {row.result && (
              <View>
                <Row label="found" value={String(row.result.found)} />
                <Row label="shotType" value={row.result.shotType ?? '—'} />
                <Row
                  label="confidence"
                  value={row.result.confidence !== undefined ? String(Math.round(row.result.confidence * 100)) + '%' : '—'}
                />
                <Row label="impactMs" value={row.result.impactTimeMs?.toString() ?? '—'} />
                <Row
                  label="trim window"
                  value={
                    typeof row.result.trimStartMs === 'number' && typeof row.result.trimEndMs === 'number'
                      ? `${row.result.trimStartMs}..${row.result.trimEndMs} (${row.result.trimEndMs - row.result.trimStartMs}ms)`
                      : '—'
                  }
                />
                <Row
                  label="trimmedUri"
                  value={row.result.trimmedUri ? '✓ created' : '✗ none'}
                  good={!!row.result.trimmedUri}
                />
              </View>
            )}
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>{label}</Text>
      <Text
        style={{
          color: good ? theme.colors.birdie : theme.colors.textPrimary,
          fontSize: 12,
          fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        }}
      >
        {value}
      </Text>
    </View>
  );
}
