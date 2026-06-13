export const config = {
  supabase: {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  },
  stripe: {
    publishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
  },
  pipeline: {
    url: process.env.EXPO_PUBLIC_PIPELINE_URL!,
    apiKey: process.env.EXPO_PUBLIC_PIPELINE_API_KEY!,
  },
  concat: {
    url: process.env.EXPO_PUBLIC_CONCAT_URL || '',
  },
  golfCourseApi: {
    key: process.env.EXPO_PUBLIC_GOLF_COURSE_API_KEY || '',
  },
  subscription: {
    websiteUrl: 'https://clippargolf.com',
    monthlyPriceAud: 1999,
    annualPriceAud: 14900,
    // When true, "Create Highlight Reel" requires an active subscription
    // (paywall shown otherwise). OFF until StoreKit IAP is live — flipping
    // this before purchases exist would lock everyone out of exports.
    enforceExportGate: false as boolean,
    // RevenueCat public SDK key (per-platform). Empty → lib/iap falls back
    // to the stub provider (Expo Go / binaries without the native module).
    revenueCatIosKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || '',
    // RevenueCat entitlement identifier that unlocks everything.
    entitlementId: 'Clippar Pro',
  },
  hardware: {
    standardPriceCents: 5900,
    premiumPriceCents: 6900,
    currency: 'aud',
  },
  processing: {
    maxJobsPerDay: 2,
    maxClipSizeMb: 10240,
  },
  upload: {
    maxRetries: 3,
    chunkSizeMb: 5,
  },
  trim: {
    defaultPreRollMs: 3000,
    defaultPostRollMs: 2000,
    autoTrimEnabled: true,
    durationPresets: [4000, 5000, 6000] as readonly number[], // 4s, 5s, 6s total
    // Per-context trim windows. `baseline` reproduces the historical 3000/2000
    // behavior; `fullSwing` is the tighter ~4s window (2500 pre + 1500 post).
    // NOTE (fix #9): putts are floored to a minimum 4000ms total trim natively
    // — that floor lives in Swift, not here. Do not encode a fake 6000 value.
    windows: {
      fullSwing: { preRollMs: 2500, postRollMs: 1500 }, // ~4s total
      baseline: { preRollMs: 3000, postRollMs: 2000 },
    },
  },
  detection: {
    // Active swing-detection strategy selected at runtime. 'baseline' is
    // byte-for-byte the historical detector (day-zero default). The other
    // strategies are additive experiments toggled via this one string.
    strategy: 'baseline' as 'baseline' | 'aboveShoulderGate' | 'velocityPeak' | 'audioFused',
    // Strategy tuning knobs forwarded to native as optionsJson. See
    // DetectionOptions in modules/shot-detector/index.ts for recognized keys.
    options: {} as Record<string, unknown>,
  },
  tracer: {
    // Master kill switch. Every tracer code path (capture, detect, geometry,
    // render, playback switching) is gated on this so the app is byte-identical
    // with it off. ENABLED for clippar-dev field testing — flip back to false
    // to instantly revert to stock behavior (originals are never modified).
    enabled: true as boolean,
    // Sub-gate within `enabled` for compass-heading capture at record start.
    captureHeading: true as boolean,
    // DEBUG OFF-SWITCH for the evidence gates, so street tests (no club, no
    // ball) still render an arc and the GPS distance + direction + visual
    // shape can be verified end-to-end. Bypasses: putt classification,
    // gps-accuracy, carry-min, bearing-delta, grounded veto, no-heading.
    // Keeps: needs a detected impact time, two GPS fixes, carry-max sanity,
    // and enough post-impact footage to animate. MUST be false for real
    // rounds — it will happily draw arcs over putts and practice swings.
    debugForceTrace: true as boolean,
    // ── Ball-launch detection knobs (forwarded to native detectBallLaunch
    //    as optionsJson; see BallLaunchOptions in modules/shot-detector) ──
    trajectoryLength: 5, // VNDetectTrajectoriesRequest points-per-trajectory (floor 5)
    minTrajectoryConfidence: 0.7,
    detectWindowPreMs: 300, // analysis window around impact on the ORIGINAL file
    detectWindowPostMs: 1700,
    fallback: 'frameDiff' as 'frameDiff' | 'none', // reserved — native stub for v1
    // ── Geometry knobs (lib/tracerMath.ts) ──
    cameraHFovLandscapeDeg: 62, // fallback when native getCameraFovDeg() is null
    tripodHeightM: 1.35,
    // horizonY is a FALLBACK only: per-clip horizon is computed from the
    // captured camera pitch (camera_pitch_deg) via computeHorizonY(). This
    // level-camera constant is used solely when pitch is null (old clips /
    // CoreMotion timeout).
    horizonY: 0.52,
    // Camera-not-facing-the-shot gate. Lateral CLAMPING is intentionally much
    // wider (xLand in [-0.30, 1.30] in tracerMath) so slices/pushes within
    // this gate exit the frame naturally. There is no static min-carry knob:
    // the floor is dynamic, max(25, 2 * (gpsAccuracyN + gpsAccuracyN1)) m.
    maxBearingDeltaDeg: 60,
    maxCarryM: 300, // beyond this the "landing" GPS is a drop/teleport outlier
    defaultCarryM: null as number | null, // null = skip when carry can't be derived
    // ── Render knobs (TracerRenderSpec defaults; widths at 1080-wide render) ──
    color: '#FF3B1F',
    coreColor: '#FFD9A0',
    lineWidthPx: 4,
    midWidthPx: 8,
    glowWidthPx: 16,
    minAnimSec: 0.5, // skip ('anim-too-short') when less post-impact time remains
    headDelaySec: 0.05, // arc draw-on starts this long after impact
    cometHead: true as boolean,
    // Carry distance burned in as a pill label near the arc apex ("82m").
    distanceLabel: true as boolean,
    // Added to the fullSwing postRollMs (capture + re-trim) when enabled, so
    // future clips keep more ball flight. 0 = no-op; set 2000 for cinematic.
    extraPostRollMs: 0,
  },
  export: {
    defaultResolution: '1080p' as const,
    defaultFrameRate: 30 as const,
    resolutionOptions: ['720p', '1080p', '2k', '4k'] as const,
    frameRateOptions: [30, 60] as const,
  },
} as const;
