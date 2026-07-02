/**
 * Tracer SIMULATION harness — dev-only screen, no course required.
 *
 * Proves the tracer end-to-end with synthetic data:
 *   1. GPS: polls getCurrentLocation({highAccuracy}) every 4s and logs each
 *      fix ([SIM-GPS]) — move the simulator's location (xcrun simctl location
 *      set) between polls to verify FRESH fixes are returned, not cached ones.
 *   2. Render (v1): builds real TracerRenderSpecs via lib/tracerMath from
 *      planted GPS pairs (straight/right/left of camera), then runs the
 *      actual native renderTracerOnClip on a bundled sample clip and plays
 *      the results.
 *   3. Render (v2): SAME planted GPS pairs, run through lib/tracerV2's
 *      computeShotCarry + buildArcSpecV2 → renderTracerV2 (the polyline
 *      render path added in #72, wired into the real editor batch in #75).
 *      This is a device bug-hunt harness: v1 is known-good (confirmed
 *      visible on device), so if v1 shows an arc and v2 doesn't on the SAME
 *      clip + geometry, the v2 native render is the culprit, not real-world
 *      geometry (an off-frame R3 arc, bad detection, etc). Look for
 *      `[TRACER-V2-RENDER]` in the device log alongside `[SIM-V2]` — it dumps
 *      the exact pixel coordinates + layer-tree state the v2 render produced.
 *
 * NOT linked from app navigation — reach it via deep link:
 *   xcrun simctl openurl booted "clippar-dev://tracer-sim"
 * Auto-runs on mount; everything is logged to Metro with [SIM-*] prefixes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import { Video, ResizeMode } from 'expo-av';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { useLocation } from '@/hooks/useLocation';
import { buildArcSpec, isTracerSkip, computeHorizonY, portraitHFovDeg, projectLanding } from '@/lib/tracerMath';
import { computeShotCarry, buildArcSpecV2, type ShotFix } from '@/lib/tracerV2';
import { config } from '@/constants/config';
import { renderTracer, renderTracerV2 } from '@/modules/shot-detector';

// ─── Inverse haversine (planted landing point) ───
const R = 6371000;
const DEG = Math.PI / 180;
function destination(lat: number, lon: number, bearingDeg: number, distM: number) {
  const d = distM / R;
  const th = bearingDeg * DEG;
  const f1 = lat * DEG;
  const l1 = lon * DEG;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: f2 / DEG, lon: l2 / DEG };
}

const TEE = { lat: -27.44463, lon: 153.01504 };
const CAMERA_HEADING = 270;

const SCENARIOS = [
  // Crash bisect ladder: bare passthrough → no shadows → full → directions.
  { name: 'BARE-passthrough', carryM: 100, shotBearingDeg: 270, flags: { debugBareExport: true } },
  { name: 'straight-100m-noshadow', carryM: 100, shotBearingDeg: 270, flags: { debugNoShadow: true } },
  { name: 'straight-100m', carryM: 100, shotBearingDeg: 270, flags: {} },
  { name: 'right-25deg-100m', carryM: 100, shotBearingDeg: 295, flags: {} },
  { name: 'left-25deg-100m', carryM: 100, shotBearingDeg: 245, flags: {} },
] as const;

// v2 SIM scenarios — the SAME planted GPS pairs/camera params as SCENARIOS
// above (so a v1-renders/v2-doesn't split isolates the v2 native render, not
// real-world geometry). Anchored on a pose-anchor synthetic launch (D3 in
// buildArcSpecV2's ladder — guaranteed in-frame; the same construction the
// D3 unit tests already exercise), so this ONLY probes the render/composition
// half of v2, not ball detection.
const V2_SCENARIOS = [
  { name: 'v2-BARE-passthrough', carryM: 100, shotBearingDeg: 270, flags: { debugBareExport: true } },
  { name: 'v2-straight-100m-noshadow', carryM: 100, shotBearingDeg: 270, flags: { debugNoShadow: true } },
  { name: 'v2-straight-100m', carryM: 100, shotBearingDeg: 270, flags: {} },
  { name: 'v2-right-25deg-100m', carryM: 100, shotBearingDeg: 295, flags: {} },
  { name: 'v2-left-25deg-100m', carryM: 100, shotBearingDeg: 245, flags: {} },
] as const;

interface RenderRow {
  name: string;
  status: string;
  uri: string | null;
}

export default function TracerSimScreen() {
  const insets = useSafeAreaInsets();
  const { getCurrentLocation } = useLocation();
  const [gpsLog, setGpsLog] = useState<string[]>([]);
  const [renders, setRenders] = useState<RenderRow[]>([]);
  const startedRef = useRef(false);

  // ── 1. GPS freshness poll ──
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const t0 = Date.now();
      const loc = await getCurrentLocation({ highAccuracy: true });
      if (!alive) return;
      const line = loc
        ? `lat=${loc.latitude.toFixed(6)} lon=${loc.longitude.toFixed(6)} acc=${loc.accuracy?.toFixed(1)}m (${Date.now() - t0}ms)`
        : `NULL fix (${Date.now() - t0}ms)`;
      console.log(`[SIM-GPS] ${line}`);
      setGpsLog((l) => [...l.slice(-7), line]);
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [getCurrentLocation]);

  // ── 2. Render scenarios through the real native pipeline ──
  const runRenders = useCallback(async () => {
    try {
      const asset = Asset.fromModule(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../assets/videos/tracer-sim-sample.mp4')
      );
      await asset.downloadAsync();
      const videoUri = asset.localUri ?? asset.uri;
      console.log(`[SIM-TRACER] sample clip: ${videoUri}`);

      for (const s of SCENARIOS) {
        setRenders((r) => [...r.filter((x) => x.name !== s.name), { name: s.name, status: 'building spec…', uri: null }]);
        const landing = destination(TEE.lat, TEE.lon, s.shotBearingDeg, s.carryM);
        const arc = buildArcSpec({
          latN: TEE.lat,
          lonN: TEE.lon,
          latN1: landing.lat,
          lonN1: landing.lon,
          gpsAccuracyMN: 6,
          gpsAccuracyMN1: 6,
          cameraHeadingDeg: CAMERA_HEADING,
          cameraHeadingCalibration: 3,
          cameraPitchDownDeg: 5,
          hFovLandscapeDeg: 62,
          clipDurationSec: 9,
          impactTimeMs: 2500,
          autoTrimStartMs: 0,
          detection: null,
        });
        if (isTracerSkip(arc)) {
          console.log(`[SIM-TRACER] ${s.name} SKIP ${arc.skip}`);
          setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: `skip: ${arc.skip}` } : x)));
          continue;
        }
        const spec = { ...arc.spec, ...s.flags } as Record<string, unknown> & typeof arc.spec;
        console.log(`[SIM-TRACER] ${s.name} spec p0=(${spec.p0.x.toFixed(2)},${spec.p0.y.toFixed(2)}) p3=(${spec.p3.x.toFixed(2)},${spec.p3.y.toFixed(2)}) label=${spec.labelText}`);
        setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: 'rendering…' } : x)));
        const t0 = Date.now();
        try {
          const { tracerUri } = await renderTracer(videoUri, JSON.stringify(spec));
          console.log(`[SIM-TRACER] ${s.name} DONE uri=${tracerUri} (${Date.now() - t0}ms)`);
          setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: tracerUri ? 'done' : 'native unavailable', uri: tracerUri } : x)));
        } catch (e) {
          console.log(`[SIM-TRACER] ${s.name} FAILED ${String(e)}`);
          setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: `failed: ${String(e)}` } : x)));
        }
      }
      console.log('[SIM-TRACER] === ALL SCENARIOS COMPLETE ===');
    } catch (e) {
      console.log(`[SIM-TRACER] harness error ${String(e)}`);
    }
  }, []);

  // ── 3. v2 render bug-hunt: SAME planted GPS/camera params as runRenders,
  //    through computeShotCarry + buildArcSpecV2 → renderTracerV2. A
  //    pose-anchor synthetic launch (poseAnchor set, no real detection fit)
  //    keeps this a pure render-path probe — geometry is guaranteed in-frame
  //    by the same D3 construction lib/tracerV2's own unit tests exercise. ──
  const runRendersV2 = useCallback(async () => {
    try {
      const asset = Asset.fromModule(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../assets/videos/tracer-sim-sample.mp4')
      );
      await asset.downloadAsync();
      const videoUri = asset.localUri ?? asset.uri;
      console.log(`[SIM-V2] sample clip: ${videoUri}`);

      const CLIP_DURATION_SEC = 9;
      const IMPACT_TIME_MS = 2500;
      const PITCH_DOWN_DEG = 5;
      const HFOV_LANDSCAPE_DEG = 62;
      const vFovPortraitDeg = HFOV_LANDSCAPE_DEG; // long axis vertical in portrait
      const hFovPortraitDeg = portraitHFovDeg(HFOV_LANDSCAPE_DEG);
      const horizonY = computeHorizonY(PITCH_DOWN_DEG, vFovPortraitDeg);
      const camHeightM = config.tracer.v2.bagMountHeightM;
      const animStartSec = IMPACT_TIME_MS / 1000 + config.tracer.headDelaySec;
      const maxAnimSec = CLIP_DURATION_SEC - animStartSec - 0.3;

      for (const s of V2_SCENARIOS) {
        setRenders((r) => [...r.filter((x) => x.name !== s.name), { name: s.name, status: 'building spec…', uri: null }]);

        const landing = destination(TEE.lat, TEE.lon, s.shotBearingDeg, s.carryM);
        const fixA: ShotFix = { lat: TEE.lat, lon: TEE.lon, effAccM: 3 };
        const fixB: ShotFix = { lat: landing.lat, lon: landing.lon, effAccM: 3 };
        const carry = computeShotCarry(fixA, fixB, CAMERA_HEADING, { headingCalibration: 3 });
        const landingPx = projectLanding({
          deltaDeg: carry.deltaDeg ?? 0,
          carryM: carry.carryM,
          horizonY,
          hFovPortraitDeg,
          vFovPortraitDeg,
          tripodHeightM: camHeightM,
        });

        const built = buildArcSpecV2({
          fit: { degenerate: true, reason: 'D2', points: [] },
          carry,
          landing: landingPx,
          horizonY,
          vFovPortraitDeg,
          camHeightM,
          animStartSec,
          maxAnimSec,
          poseAnchor: { x: 0.5, y: 0.2 },
          detectedDirection: null,
          rollDeg: 0,
        });
        const spec = { ...built, ...s.flags } as Record<string, unknown> & typeof built;

        const first = spec.samples[0];
        const last = spec.samples[spec.samples.length - 1];
        const apex = spec.samples.reduce((a, b) => (b.y > a.y ? b : a), first);
        console.log(
          `[SIM-V2] ${s.name} spec sampleCount=${spec.samples.length} ` +
          `first=(${first.x.toFixed(2)},${first.y.toFixed(2)}) ` +
          `last=(${last.x.toFixed(2)},${last.y.toFixed(2)}) ` +
          `apex=(${apex.x.toFixed(2)},${apex.y.toFixed(2)}) ` +
          `label=${spec.labelText} rung=${carry.tier}`
        );
        setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: 'rendering…' } : x)));
        const t0 = Date.now();
        try {
          // JSON-encode: the native-facing TracerRenderSpecV2 (modules/shot-
          // detector) types labelText `string | undefined`, lib/tracerV2's own
          // types it `string | null` — identical on the wire, cross-module
          // mismatch only (same workaround as hooks/useEditorState.ts).
          const { tracerUri } = await renderTracerV2(videoUri, JSON.stringify(spec));
          console.log(`[SIM-V2] ${s.name} DONE uri=${tracerUri} (${Date.now() - t0}ms)`);
          setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: tracerUri ? 'done' : 'native unavailable', uri: tracerUri } : x)));
        } catch (e) {
          console.log(`[SIM-V2] ${s.name} FAILED ${String(e)}`);
          setRenders((r) => r.map((x) => (x.name === s.name ? { ...x, status: `failed: ${String(e)}` } : x)));
        }
      }
      console.log('[SIM-V2] === ALL SCENARIOS COMPLETE ===');
    } catch (e) {
      console.log(`[SIM-V2] harness error ${String(e)}`);
    }
  }, []);

  const runAll = useCallback(async () => {
    await runRenders();
    await runRendersV2();
  }, [runRenders, runRendersV2]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runAll();
  }, [runAll]);

  return (
    <GradientBackground>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView style={{ flex: 1, paddingTop: insets.top + 12 }} contentContainerStyle={{ padding: 16, paddingBottom: 64 }}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>
          Tracer Simulation
        </Text>

        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: 8 }}>GPS (fresh-fix poll, 4s)</Text>
        {gpsLog.map((l, i) => (
          <Text key={i} style={{ color: theme.colors.textSecondary, fontSize: 11, fontFamily: 'Courier' }}>{l}</Text>
        ))}

        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: 20 }}>
          V1 Renders (known-good — renderTracerOnClip)
        </Text>
        {renders.filter((r) => !r.name.startsWith('v2-')).map((r) => (
          <View key={r.name} style={{ marginTop: 12 }}>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>{r.name} — {r.status}</Text>
            {r.uri ? (
              <Video
                source={{ uri: r.uri }}
                style={{ width: 220, height: 391, marginTop: 6, borderRadius: 8 }}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
                isLooping
                isMuted
              />
            ) : null}
          </View>
        ))}

        <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: 20 }}>
          V2 Renders (bug hunt — renderTracerV2, same geometry as V1 above)
        </Text>
        {renders.filter((r) => r.name.startsWith('v2-')).map((r) => (
          <View key={r.name} style={{ marginTop: 12 }}>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>{r.name} — {r.status}</Text>
            {r.uri ? (
              <Video
                source={{ uri: r.uri }}
                style={{ width: 220, height: 391, marginTop: 6, borderRadius: 8 }}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
                isLooping
                isMuted
              />
            ) : null}
          </View>
        ))}

        <Pressable
          onPress={runAll}
          style={{ marginTop: 24, backgroundColor: theme.colors.primary, borderRadius: 10, padding: 14, alignItems: 'center' }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Re-run renders (v1 + v2)</Text>
        </Pressable>
      </ScrollView>
    </GradientBackground>
  );
}
