/**
 * Detection A/B harness — dev-only summary screen.
 *
 * Reads the ring buffer persisted by lib/detectionLog.ts (key
 * 'detection_ab_log' in local_settings, last ~100 detectAndTrim results) and
 * renders a per-strategy summary table:
 *   - count            : rows logged for that strategy
 *   - mean confidence  : average detection confidence
 *   - %audio matched   : among rows where audio was USABLE, the share where an
 *                        audio onset was actually snapped to (honest A/B denom)
 *
 * This is intentionally minimal and read-only (plus a "Clear" button). It is
 * NOT linked from app navigation — reach it via the (dev) route during A/B
 * runs. No DB migration, no native dependency.
 */

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
} from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import {
  getDetectionLog,
  clearDetectionLog,
  summarizeDetectionLog,
  type DetectionLogRow,
  type DetectionStrategySummary,
} from '@/lib/detectionLog';

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function fmtConf(v: number | null): string {
  return v == null ? '—' : v.toFixed(2);
}

export default function DetectionABScreen() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<DetectionLogRow[]>([]);
  const [summaries, setSummaries] = useState<DetectionStrategySummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const data = await getDetectionLog();
    setRows(data);
    setSummaries(summarizeDetectionLog(data));
  }, []);

  // Reload every time the screen gains focus (e.g. after an A/B run).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onClear = useCallback(async () => {
    await clearDetectionLog();
    await load();
  }, [load]);

  return (
    <GradientBackground>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
          }}
        >
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <ArrowLeft size={22} color={theme.colors.textPrimary} />
            <Text
              style={{
                color: theme.colors.textPrimary,
                ...theme.typography.h3,
              }}
            >
              Detection A/B
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Pressable onPress={onRefresh} hitSlop={12}>
              <RefreshCw size={20} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable onPress={onClear} hitSlop={12}>
              <Trash2 size={20} color={theme.colors.accentRed} />
            </Pressable>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: theme.spacing.md,
            paddingBottom: insets.bottom + theme.spacing.xl,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.textSecondary}
            />
          }
        >
          <Text
            style={{
              color: theme.colors.textSecondary,
              ...theme.typography.bodySmall,
              marginBottom: theme.spacing.md,
            }}
          >
            {rows.length} row{rows.length === 1 ? '' : 's'} logged (last ~100).
            %audio matched is among audio-USABLE rows only.
          </Text>

          {summaries.length === 0 ? (
            <View
              style={{
                padding: theme.spacing.lg,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
              }}
            >
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  ...theme.typography.body,
                  textAlign: 'center',
                }}
              >
                No detections logged yet. Record or import a clip, then pull to
                refresh.
              </Text>
            </View>
          ) : (
            <View
              style={{
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                overflow: 'hidden',
              }}
            >
              {/* Table header */}
              <View
                style={{
                  flexDirection: 'row',
                  paddingVertical: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.md,
                  backgroundColor: theme.colors.surfaceElevated,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.surfaceBorder,
                }}
              >
                <HeaderCell label="Strategy" flex={2.2} />
                <HeaderCell label="N" flex={0.7} align="right" />
                <HeaderCell label="Conf" flex={1} align="right" />
                <HeaderCell label="Audio" flex={1.2} align="right" />
              </View>

              {summaries.map((s, i) => (
                <View
                  key={s.strategy}
                  style={{
                    flexDirection: 'row',
                    paddingVertical: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.md,
                    borderBottomWidth: i === summaries.length - 1 ? 0 : 1,
                    borderBottomColor: theme.colors.surfaceBorder,
                  }}
                >
                  <BodyCell
                    flex={2.2}
                    text={s.strategy}
                    color={theme.colors.textPrimary}
                    weight="600"
                  />
                  <BodyCell flex={0.7} text={String(s.count)} align="right" />
                  <BodyCell
                    flex={1}
                    text={fmtConf(s.meanConfidence)}
                    align="right"
                  />
                  <BodyCell
                    flex={1.2}
                    text={`${fmtPct(s.audioMatchedPct)} (${s.audioMatchedCount}/${s.audioUsableCount})`}
                    align="right"
                  />
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </GradientBackground>
  );
}

function HeaderCell({
  label,
  flex,
  align = 'left',
}: {
  label: string;
  flex: number;
  align?: 'left' | 'right';
}) {
  return (
    <Text
      style={{
        flex,
        color: theme.colors.textTertiary,
        ...theme.typography.caption,
        textAlign: align,
      }}
    >
      {label}
    </Text>
  );
}

function BodyCell({
  text,
  flex,
  align = 'left',
  color = theme.colors.textSecondary,
  weight = '400',
}: {
  text: string;
  flex: number;
  align?: 'left' | 'right';
  color?: string;
  weight?: '400' | '600';
}) {
  return (
    <Text
      style={{
        flex,
        color,
        fontSize: 14,
        fontWeight: weight,
        textAlign: align,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}
