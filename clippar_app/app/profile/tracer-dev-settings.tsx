/**
 * Tracer dev settings — dev-build-only knobs for field-testing the shot tracer
 * without a rebuild.
 *
 * Ported from `origin/tracer-v2:clippar_app/app/profile/tracer-dev-settings.tsx`
 * (the SettingCard, the two evidence-gate bypasses and the mutate-config-then-
 * persist pattern are that screen's, unchanged) and extended for V3: the engine
 * switch, the render knobs, and a read-out of what the last batch actually
 * decided.
 *
 * HOW THE TOGGLES TAKE EFFECT. They mutate `config.tracer` in memory. Every
 * consumer reads `config.tracer.X` live at batch time rather than capturing it,
 * so a flip lands on the NEXT `processAllTracers` pass with no reload — which is
 * the whole point on a course, where a rebuild is not available. Each value is
 * also written to the SQLite settings table and rehydrated on mount, so a
 * setting survives an app restart — WITH ONE EXCEPTION.
 *
 * THE EVIDENCE-GATE BYPASSES ARE NOT PERSISTED (docs/tracer-v3/review.md, F6).
 * This file used to claim that "`constants/config.ts` always BOOTS with the
 * real-round-safe values, so a crash mid-round cannot leave a bypass on". True
 * as written, and beside the point: the way a bypass came back on was not a
 * crash, it was OPENING THIS SCREEN. Every mount rehydrated the stored value
 * into `config.tracer`, and this screen is also the only place to read what the
 * last batch decided — so the natural mid-round action ("why did that skip?")
 * silently re-armed a bypass left over from a street test three days earlier.
 * `forceTrace` is a bench switch and re-flipping it costs one tap, so it is now
 * in-memory for the session only: it boots off, and nothing but a deliberate
 * tap turns it on.
 *
 * The v2 screen's "Default Club Carry" and "Show Distance Label" rows are NOT
 * ported. They drove v2 knobs that V3 does not have: V3 never invents a carry
 * (a shot with no successor renders pixel-only and says "no GPS"), and its pill
 * is rounded by the fit's own error budget rather than switched on and off.
 * Porting dead controls is how a settings screen starts lying.
 */
import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Switch, Pressable } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Radar, Bug, MapPinned, Users, Snowflake, Tag, Satellite } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import { getSetting, setSetting, getRecentTracerDiagnostics } from '@/lib/storage';
import { gpsSession, type GpsHealth } from '@/lib/gpsSession';
import type { TracerV3Meta } from '@/lib/tracerV3';

const SETTING_DEBUG_FORCE_TRACE = 'tracer_v2_debug_force_trace';
const SETTING_GPS_ONLY_TRACE = 'tracer_v2_gps_only_trace';
const SETTING_ENGINE = 'tracer_engine';
const SETTING_V3_OCCLUSION = 'tracer_v3_occlusion';
const SETTING_V3_FREEZE = 'tracer_v3_freeze_complete';
const SETTING_V3_LABEL_ROUNDING = 'tracer_v3_label_rounding';
// NOTE: there is deliberately no SETTING_* key for the V3 force-trace switch.
// It is session-only (F6, above). The orphan `tracer_v3_force_trace` row a
// previous build may have written is simply never read again; it is left in
// place rather than deleted because a settings write on mount is a side effect
// this screen should not have.

function SettingCard({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  trailing: React.ReactNode;
}) {
  return (
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
            {icon}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
              {title}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
              {subtitle}
            </Text>
          </View>
        </View>
        {trailing}
      </View>
    </View>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '700',
        marginTop: 12,
        marginBottom: 8,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {children}
    </Text>
  );
}

interface DecisionRow {
  id: number;
  hole: number;
  shot: number;
  status: string;
  decision: string;
  reason: string | null;
  detail: string;
}

/** One clip's tracer_meta rendered as a line a person can read on a phone. */
function describeRow(row: {
  id: number;
  hole_number: number;
  shot_number: number;
  tracer_status: string | null;
  tracer_meta: string | null;
}): DecisionRow {
  let meta: Partial<TracerV3Meta> | null = null;
  try {
    meta = row.tracer_meta ? (JSON.parse(row.tracer_meta) as Partial<TracerV3Meta>) : null;
  } catch {
    meta = null;
  }
  const parts: string[] = [];
  if (meta?.selection) parts.push(`K=${meta.selection.k}`);
  if (meta?.fit) parts.push(`rms ${meta.fit.rmsPx.toFixed(1)}px`);
  if (meta?.flight) parts.push(`carry ${meta.flight.carryM.toFixed(0)}m`);
  if (meta?.flight) parts.push(`apex ${meta.flight.apexM.toFixed(0)}m`);
  if (meta?.carry?.status) parts.push(meta.carry.status);
  if (meta?.flags?.length) parts.push(meta.flags.join(' '));
  return {
    id: row.id,
    hole: row.hole_number,
    shot: row.shot_number,
    status: row.tracer_status ?? '—',
    // A v1 row has no `engine`/`decision`; say so rather than showing a blank.
    decision: meta?.decision ?? (meta ? 'v1' : '—'),
    reason: meta?.reason ?? null,
    detail: parts.join(' · '),
  };
}

export default function TracerDevSettingsScreen() {
  const [loaded, setLoaded] = useState(false);
  const [engineV3, setEngineV3] = useState(config.tracer.engine === 'v3');
  const [debugForceTrace, setDebugForceTrace] = useState(config.tracer.debugForceTrace);
  const [gpsOnlyTrace, setGpsOnlyTrace] = useState(config.tracer.gpsOnlyTrace);
  const [occlusion, setOcclusion] = useState(config.tracer.v3.occlusion);
  const [freeze, setFreeze] = useState(config.tracer.v3.freezeComplete);
  const [labelRounding, setLabelRounding] = useState(config.tracer.v3.labelRounding);
  const [v3ForceTrace, setV3ForceTrace] = useState(config.tracer.v3.forceTrace);
  const [health, setHealth] = useState<GpsHealth>({ effAccM: null, state: 'off', fixCount: 0 });
  const [rows, setRows] = useState<DecisionRow[]>([]);

  useEffect(() => {
    (async () => {
      const [engine, forceTrace, gpsOnly, occ, frz, lbl] = await Promise.all([
        getSetting(SETTING_ENGINE),
        getSetting(SETTING_DEBUG_FORCE_TRACE),
        getSetting(SETTING_GPS_ONLY_TRACE),
        getSetting(SETTING_V3_OCCLUSION),
        getSetting(SETTING_V3_FREEZE),
        getSetting(SETTING_V3_LABEL_ROUNDING),
      ]);
      // Rehydrate every persisted override into the live config object, so a
      // toggle from a previous session takes effect again. Only an EXPLICIT
      // stored value overrides the compiled default — an absent key leaves the
      // real-round-safe boot value alone.
      if (engine === 'v1' || engine === 'v3') {
        (config.tracer as { engine: 'v1' | 'v3' }).engine = engine;
        setEngineV3(engine === 'v3');
      }
      if (forceTrace === '1') {
        (config.tracer as { debugForceTrace: boolean }).debugForceTrace = true;
        setDebugForceTrace(true);
      }
      if (gpsOnly === '1') {
        (config.tracer as { gpsOnlyTrace: boolean }).gpsOnlyTrace = true;
        setGpsOnlyTrace(true);
      }
      if (occ === '0' || occ === '1') {
        const v = occ === '1';
        (config.tracer.v3 as { occlusion: boolean }).occlusion = v;
        setOcclusion(v);
      }
      if (frz === '0' || frz === '1') {
        const v = frz === '1';
        (config.tracer.v3 as { freezeComplete: boolean }).freezeComplete = v;
        setFreeze(v);
      }
      if (lbl === '0' || lbl === '1') {
        const v = lbl === '1';
        (config.tracer.v3 as { labelRounding: boolean }).labelRounding = v;
        setLabelRounding(v);
      }
      // F6: `forceTrace` is NOT rehydrated. See the header comment.
      setLoaded(true);
    })();
  }, []);

  const refreshRows = useCallback(async () => {
    try {
      const recent = await getRecentTracerDiagnostics(25);
      setRows(recent.map(describeRow));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  // GPS health is READ, never started, from this screen. Starting a second
  // watch here would push duplicate fixes into the same singleton ring and
  // quietly corrupt the very estimate this screen exists to inspect; the record
  // tab owns the subscription.
  useEffect(() => {
    const id = setInterval(() => setHealth(gpsSession.currentEffAcc(Date.now())), 1000);
    return () => clearInterval(id);
  }, []);

  const persistBool = useCallback(async (key: string, val: boolean) => {
    await setSetting(key, val ? '1' : '0');
  }, []);

  const toggleEngine = useCallback(
    async (v3: boolean) => {
      Haptics.selectionAsync();
      setEngineV3(v3);
      (config.tracer as { engine: 'v1' | 'v3' }).engine = v3 ? 'v3' : 'v1';
      await setSetting(SETTING_ENGINE, v3 ? 'v3' : 'v1');
    },
    []
  );

  const toggleDebugForceTrace = useCallback(
    async (val: boolean) => {
      Haptics.selectionAsync();
      setDebugForceTrace(val);
      (config.tracer as { debugForceTrace: boolean }).debugForceTrace = val;
      await persistBool(SETTING_DEBUG_FORCE_TRACE, val);
    },
    [persistBool]
  );

  const toggleGpsOnlyTrace = useCallback(
    async (val: boolean) => {
      Haptics.selectionAsync();
      setGpsOnlyTrace(val);
      (config.tracer as { gpsOnlyTrace: boolean }).gpsOnlyTrace = val;
      await persistBool(SETTING_GPS_ONLY_TRACE, val);
    },
    [persistBool]
  );

  const toggleOcclusion = useCallback(
    async (val: boolean) => {
      Haptics.selectionAsync();
      setOcclusion(val);
      (config.tracer.v3 as { occlusion: boolean }).occlusion = val;
      await persistBool(SETTING_V3_OCCLUSION, val);
    },
    [persistBool]
  );

  const toggleFreeze = useCallback(
    async (val: boolean) => {
      Haptics.selectionAsync();
      setFreeze(val);
      (config.tracer.v3 as { freezeComplete: boolean }).freezeComplete = val;
      await persistBool(SETTING_V3_FREEZE, val);
    },
    [persistBool]
  );

  const toggleLabelRounding = useCallback(
    async (val: boolean) => {
      Haptics.selectionAsync();
      setLabelRounding(val);
      (config.tracer.v3 as { labelRounding: boolean }).labelRounding = val;
      await persistBool(SETTING_V3_LABEL_ROUNDING, val);
    },
    [persistBool]
  );

  const toggleV3ForceTrace = useCallback((val: boolean) => {
    Haptics.selectionAsync();
    setV3ForceTrace(val);
    // In memory only, and deliberately (F6). Nothing is written, so the next
    // launch — and every later mount of this screen — starts from the
    // real-round-safe boot value in constants/config.ts.
    (config.tracer.v3 as { forceTrace: boolean }).forceTrace = val;
  }, []);

  if (!loaded) return null;

  const healthColour =
    health.state === 'green'
      ? theme.colors.primary
      : health.state === 'yellow'
        ? theme.colors.textPrimary
        : theme.colors.accentRed;

  return (
    <>
      <Stack.Screen options={{ title: 'Tracer Dev Settings' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
          Dev-build-only overrides for the shot tracer (config.tracer). Never visible outside
          clippar-dev — real rounds always boot with the debug bypasses off.
        </Text>

        <SettingCard
          icon={<Radar size={18} color={theme.colors.primary} />}
          title="Engine"
          subtitle={
            engineV3
              ? 'V3 — physics pipeline (detector → camera → RK4 fit → ladder → polyline)'
              : 'V1 — Vision trajectory + Bézier arc (the shipped path)'
          }
          trailing={
            <Switch
              value={engineV3}
              onValueChange={toggleEngine}
              trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
              thumbColor="#fff"
            />
          }
        />

        <SettingCard
          icon={<Satellite size={18} color={healthColour} />}
          title="GPS session"
          subtitle={
            health.effAccM === null
              ? `${health.state} — no usable fix right now (the record tab owns the watch)`
              : `${health.state} · ±${health.effAccM.toFixed(1)} m effective · ${health.fixCount} fixes in window`
          }
          trailing={<View />}
        />

        {engineV3 && (
          <>
            <SectionHeading>V3 render</SectionHeading>

            <SettingCard
              icon={<Users size={18} color={theme.colors.primary} />}
              title="Person occlusion"
              subtitle="Hide the trace behind the golfer (Vision person segmentation, every frame)"
              trailing={
                <Switch
                  value={occlusion}
                  onValueChange={toggleOcclusion}
                  trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
                  thumbColor="#fff"
                />
              }
            />

            <SettingCard
              icon={<Snowflake size={18} color={theme.colors.primary} />}
              title="Freeze completion"
              subtitle="Hold the last frame so a flight that outlasts the clip still lands"
              trailing={
                <Switch
                  value={freeze}
                  onValueChange={toggleFreeze}
                  trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
                  thumbColor="#fff"
                />
              }
            />

            <SettingCard
              icon={<Tag size={18} color={theme.colors.primary} />}
              title="Honest label rounding"
              subtitle="Round the pill to the fit's own 1 / 5 / 10 m step. OFF over-claims precision"
              trailing={
                <Switch
                  value={labelRounding}
                  onValueChange={toggleLabelRounding}
                  trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
                  thumbColor="#fff"
                />
              }
            />
          </>
        )}

        <SectionHeading>Evidence-gate bypasses — never for a real round</SectionHeading>

        {engineV3 ? (
          <SettingCard
            icon={<Bug size={18} color={theme.colors.accentRed} />}
            title="Force Trace (V3 debug)"
            subtitle="Bypasses putt / not-a-flight / poor-fit refusals so club-less street tests still render. Session only — turns itself off on the next launch"
            trailing={
              <Switch
                value={v3ForceTrace}
                onValueChange={toggleV3ForceTrace}
                trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.accentRed }}
                thumbColor="#fff"
              />
            }
          />
        ) : (
          <>
            <SettingCard
              icon={<Bug size={18} color={theme.colors.accentRed} />}
              title="Force Trace (V1 debug)"
              subtitle="Bypasses putt/grounded classification so club-less street tests still render"
              trailing={
                <Switch
                  value={debugForceTrace}
                  onValueChange={toggleDebugForceTrace}
                  trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.accentRed }}
                  thumbColor="#fff"
                />
              }
            />

            <SettingCard
              icon={<MapPinned size={18} color={theme.colors.accentRed} />}
              title="GPS-Only Trace (V1 debug)"
              subtitle="Skips the Vision pass entirely — renders from GPS geometry alone, even on a black screen"
              trailing={
                <Switch
                  value={gpsOnlyTrace}
                  onValueChange={toggleGpsOnlyTrace}
                  trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.accentRed }}
                  thumbColor="#fff"
                />
              }
            />
          </>
        )}

        {(debugForceTrace || gpsOnlyTrace || v3ForceTrace) && (
          <Text style={{ color: theme.colors.accentRed, fontSize: 12, marginTop: 4 }}>
            ⚠️ A debug bypass is ON — turn it off before recording a real round. It will draw
            arcs over putts.
          </Text>
        )}

        <SectionHeading>Last batch — what it decided</SectionHeading>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            void refreshRows();
          }}
          style={{
            alignSelf: 'flex-start',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            marginBottom: 12,
          }}
        >
          <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
            Refresh
          </Text>
        </Pressable>

        {rows.length === 0 ? (
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
            No clip has been through the tracer yet.
          </Text>
        ) : (
          rows.map((r) => (
            <View
              key={r.id}
              style={{
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
                padding: 12,
                marginBottom: 8,
              }}
            >
              <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: '600' }}>
                H{r.hole} S{r.shot} · {r.status} · {r.decision}
              </Text>
              {r.reason !== null && (
                <Text style={{ color: theme.colors.accentRed, fontSize: 11, marginTop: 2 }}>
                  {r.reason}
                </Text>
              )}
              {r.detail.length > 0 && (
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                  {r.detail}
                </Text>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </>
  );
}
