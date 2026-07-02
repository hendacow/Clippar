/**
 * Tracer V2 dev settings (S11) — dev-build-only knobs for field-testing the
 * GPS-backbone tracer without a rebuild. Entry point in (tabs)/profile.tsx
 * is gated on variantIsDev(); this screen mutates `config.tracer` directly
 * for the two evidence-gate bypasses (they're read live via `config.tracer.X`
 * throughout lib/tracerV2.ts + hooks/useEditorState.ts, so an in-memory
 * mutation takes effect on the NEXT processAllTracers batch with no reload)
 * and persists everything to SQLite settings so it survives app restart.
 */
import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Switch, TextInput, Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Radar, Ruler, Tag, Bug, MapPinned } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { config } from '@/constants/config';
import {
  getSetting,
  setSetting,
  getTracerDevSettings,
  setTracerDisabled,
  setTracerDefaultCarryM,
  setTracerShowDistanceLabel,
} from '@/lib/storage';

const SETTING_DEBUG_FORCE_TRACE = 'tracer_v2_debug_force_trace';
const SETTING_GPS_ONLY_TRACE = 'tracer_v2_gps_only_trace';

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

export default function TracerDevSettingsScreen() {
  const [loaded, setLoaded] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [defaultCarryM, setDefaultCarryMState] = useState<number | null>(null);
  const [carryInput, setCarryInput] = useState('');
  const [showDistanceLabel, setShowDistanceLabelState] = useState(true);
  const [debugForceTrace, setDebugForceTrace] = useState(config.tracer.debugForceTrace);
  const [gpsOnlyTrace, setGpsOnlyTrace] = useState(config.tracer.gpsOnlyTrace);

  useEffect(() => {
    (async () => {
      const [dev, forceTrace, gpsOnly] = await Promise.all([
        getTracerDevSettings(),
        getSetting(SETTING_DEBUG_FORCE_TRACE),
        getSetting(SETTING_GPS_ONLY_TRACE),
      ]);
      setDisabled(dev.disabled);
      setDefaultCarryMState(dev.defaultCarryM);
      setCarryInput(dev.defaultCarryM ? String(dev.defaultCarryM) : '');
      setShowDistanceLabelState(dev.showDistanceLabel);
      // Rehydrate the two evidence-gate bypasses into the live config object
      // so a persisted toggle from a previous session takes effect again —
      // config.ts itself always boots with both `false` (real-round safe).
      if (forceTrace === '1') {
        (config.tracer as { debugForceTrace: boolean }).debugForceTrace = true;
        setDebugForceTrace(true);
      }
      if (gpsOnly === '1') {
        (config.tracer as { gpsOnlyTrace: boolean }).gpsOnlyTrace = true;
        setGpsOnlyTrace(true);
      }
      setLoaded(true);
    })();
  }, []);

  const toggleDisabled = useCallback(async (val: boolean) => {
    Haptics.selectionAsync();
    setDisabled(val);
    await setTracerDisabled(val);
  }, []);

  const toggleShowLabel = useCallback(async (val: boolean) => {
    Haptics.selectionAsync();
    setShowDistanceLabelState(val);
    await setTracerShowDistanceLabel(val);
  }, []);

  const commitCarry = useCallback(async () => {
    const n = Number(carryInput);
    const val = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    setDefaultCarryMState(val);
    setCarryInput(val ? String(val) : '');
    await setTracerDefaultCarryM(val);
  }, [carryInput]);

  const toggleDebugForceTrace = useCallback(async (val: boolean) => {
    Haptics.selectionAsync();
    setDebugForceTrace(val);
    (config.tracer as { debugForceTrace: boolean }).debugForceTrace = val;
    await setSetting(SETTING_DEBUG_FORCE_TRACE, val ? '1' : '0');
  }, []);

  const toggleGpsOnlyTrace = useCallback(async (val: boolean) => {
    Haptics.selectionAsync();
    setGpsOnlyTrace(val);
    (config.tracer as { gpsOnlyTrace: boolean }).gpsOnlyTrace = val;
    await setSetting(SETTING_GPS_ONLY_TRACE, val ? '1' : '0');
  }, []);

  if (!loaded) return null;

  return (
    <>
      <Stack.Screen options={{ title: 'Tracer Dev Settings' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
          Dev-build-only overrides for the GPS-backbone shot tracer (config.tracer). Never
          visible outside clippar-dev — real rounds always boot with these off.
        </Text>

        <SettingCard
          icon={<Radar size={18} color={theme.colors.primary} />}
          title="Tracer Processing"
          subtitle={disabled ? 'Disabled — no tracers will render this session' : 'Enabled'}
          trailing={
            <Switch
              value={!disabled}
              onValueChange={(val) => toggleDisabled(!val)}
              trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
              thumbColor="#fff"
            />
          }
        />

        <SettingCard
          icon={<Ruler size={18} color={theme.colors.primary} />}
          title="Default Club Carry"
          subtitle="Feeds the R3/R4 prior when GPS carry is unusable — blank uses the built-in bucket average"
          trailing={
            <TextInput
              value={carryInput}
              onChangeText={setCarryInput}
              onBlur={commitCarry}
              onSubmitEditing={commitCarry}
              placeholder="140"
              placeholderTextColor={theme.colors.textTertiary}
              keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
              style={{
                width: 64,
                textAlign: 'right',
                color: theme.colors.textPrimary,
                fontSize: 15,
                fontWeight: '600',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.surfaceBorder,
                paddingVertical: 4,
              }}
            />
          }
        />
        {defaultCarryM != null && (
          <Text style={{ color: theme.colors.textTertiary, fontSize: 11, marginTop: -6, marginBottom: 12, marginLeft: 4 }}>
            Currently {defaultCarryM}m
          </Text>
        )}

        <SettingCard
          icon={<Tag size={18} color={theme.colors.primary} />}
          title="Show Distance Label"
          subtitle="Burn in the carry pill (142m / ~140m) on Tier1/2 renders"
          trailing={
            <Switch
              value={showDistanceLabel}
              onValueChange={toggleShowLabel}
              trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
              thumbColor="#fff"
            />
          }
        />

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
          Evidence-gate bypasses — real rounds only
        </Text>

        <SettingCard
          icon={<Bug size={18} color={theme.colors.accentRed} />}
          title="Force Trace (debug)"
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
          title="GPS-Only Trace (debug)"
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

        {(debugForceTrace || gpsOnlyTrace) && (
          <Text style={{ color: theme.colors.accentRed, fontSize: 12, marginTop: 4 }}>
            ⚠️ At least one debug bypass is ON — turn both off before recording a real round.
          </Text>
        )}
      </ScrollView>
    </>
  );
}
