import { variantIsDev } from '../lib/variant';

export const config = {
  supabase: {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  },
  stripe: {
    publishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
    // Apple Pay merchant ID. Must be registered in the Apple Developer
    // portal (Certificates → Identifiers → Merchant IDs) and the bundle's
    // provisioning profile must carry the Apple Pay capability. One merchant
    // ID is shared across app variants. EAS adds the capability automatically
    // once this ID exists; the @stripe/stripe-react-native Expo plugin
    // (app.config.js) adds the in-app-payments entitlement.
    merchantIdentifier: 'merchant.com.clippar.app',
    merchantCountryCode: 'AU',
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
    // EXPO_PUBLIC_RC_IOS_KEY is the canonical name; the longer
    // EXPO_PUBLIC_REVENUECAT_IOS_KEY is accepted as a legacy alias so existing
    // EAS env vars keep working. Android later: add EXPO_PUBLIC_RC_ANDROID_KEY
    // and a Platform.select — the lib/iap seam means no UI rewrite.
    revenueCatIosKey:
      process.env.EXPO_PUBLIC_RC_IOS_KEY ||
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ||
      '',
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
    // with it off. v2: gated to the development (clippar-dev) build only via
    // variantIsDev(), so staging and production stay byte-identical stock
    // behavior while v2 field-tests in dev. variantIsDev() is node-safe (see
    // lib/variant.ts) so config.ts stays importable under plain node (tests /
    // simulate-tracer). Originals are never modified — a pure on/off, no data
    // risk.
    enabled: variantIsDev() as boolean,
    // Sub-gate within `enabled` for compass-heading capture at record start.
    captureHeading: true as boolean,
    // DEBUG OFF-SWITCH for the evidence gates, so street tests (no club, no
    // ball) still render an arc and the GPS distance + direction + visual
    // shape can be verified end-to-end. Bypasses: putt classification,
    // gps-accuracy, carry-min, bearing-delta, grounded veto, no-heading.
    // Keeps: needs a detected impact time, two GPS fixes, carry-max sanity,
    // and enough post-impact footage to animate. MUST be false for real
    // rounds — it will happily draw arcs over putts and practice swings.
    debugForceTrace: false as boolean,
    // GPS-ONLY TEST MODE: the tracer is driven purely by geometry — it
    // 100% renders (even on a black screen) when BOTH clips have GPS, the
    // fixes are ≥25m and ≤300m apart, and the bearing to the "landing" is
    // within maxBearingDeltaDeg of the camera heading. Skips swing/putt
    // classification, ball detection (Vision pass not even run), GPS
    // accuracy and grounded/no-heading evidence gates; impact anchors on
    // the detected swing when present, else the clip midpoint. MUST be
    // false for real rounds.
    gpsOnlyTrace: false as boolean,
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

    // ── v2 GPS backbone (lib/gpsSession.ts, lib/tracerV2.ts) ──
    // The estimator turns the ~1Hz ring buffer into one accuracy-weighted
    // per-shot fix + effAcc + tier. See plan Pillar 1 / A1 / A2 / A3.
    gps: {
      warmupSec: 15, // first N seconds after start/resume excluded as junk
      windowPreSec: 25, // STOP-anchor stationary window before the anchor
      // MERGE-NOTE (Lane A / feat/tracer-v2-gps): these are the STOP-anchor
      // window. Reconciled with plan A1 [stop−25s, stop+10s] → windowPostSec is
      // 10 (was 3). The IMPACT anchor uses a tighter 15s pre-window
      // (IMPACT_PRE_SEC in lib/gpsSession.ts; no config field) plus this same
      // +10s post. Scaffold owns this block — folding this one value in per
      // reviewer direction; flag on merge.
      windowPostSec: 10, // stationary window after the anchor (both anchor types)
      widenPreSec: 45, // widen the pre-window when too few fixes land
      stationarySpeedMax: 0.7, // m/s — above this the golfer is walking
      fixAccMax: 20, // m — drop fixes reporting worse horizontalAccuracy
      minFixes: 5, // fewer accepted fixes than this → widen / degrade
      effAccFloor: 2.5, // m — honest precision ceiling; don't chase sub-meter
      safetyFactor: 1.2, // iOS accuracy is optimistic; multipath decorrelates
      tier1EffAccM: 5, // Tier 1 needs both endpoints ≤ this
      tier2EffAccM: 10, // Tier 2 needs both endpoints ≤ this
      tier2RelSigma: 0.1, // Tier 2 needs σ_d/carry ≤ this
      tier1CarryMinM: 20, // Tier 1 carry range floor
      tier1CarryMaxM: 350, // Tier 1 carry range ceiling
      staleSec: 10, // all fixes older than this → gps-stale (never cached)
      filmSpotOffsetVarM: 3, // A2: phone-behind-ball offset folded into σ_d
    },

    // ── v2 two-segment arc shaping (lib/tracerV2.ts) ──
    // Pseudo-gravity / apex / launch caps for the closed-form synthetic
    // segment. See plan Pillar 4 / A4.
    arc: {
      gMax: 1.5, // cap on |g_down / g_up|; when it binds the descent EXTENDS
      // (t_down lengthens) to still hit the landing smoothly — never teleports.
      tUpFracMax: 0.7, // t_up ≤ this × t_rem, else re-solve y_apex
      tRemMin: 0.8, // s — minimum remaining flight time to shape a segment
      kApexLo: 0.13, // apex = lerp(kApexLo, kApexHi, vy0-norm) × carry
      kApexHi: 0.22,
      vy0Lo: 0.35, // normalized climb range the apex lerp maps across
      vy0Hi: 0.9,
      // F8b lateral-sign override fires only when the LATERAL curvature residual
      // (x-only, so vertical gravity sag never counts) exceeds this.
      f8bCurvatureMin: 0.02,
      // A4 damp-blend window (s): the V_h clamp / lateral straightening ramps in
      // over the first this-many seconds AFTER the handoff, leaving the detected
      // segment untouched and keeping C1 exact at the seam.
      dampBlendSec: 0.15,
      // A4 clamp ceiling on screen vertical handoff velocity, per bucket
      // (normalized screen-heights / sec).
      vyMaxNorm: { drive: 1.6, iron: 1.8, wedge: 2.2 },
      // Huber residual scale (normalized screen units) for endpoint robustifying.
      huberK: 0.04,
      // D4 whole-flight-visible: when the handoff is already at/near the landing
      // (|P_h.y − y_land| ≤ this) or descending, skip the synthetic apex and just
      // fade the detected flight out over `wholeFlightTailSec`.
      wholeFlightYTol: 0.03,
      wholeFlightTailSec: 0.2,
    },

    // ── v2 estimator / prior config (lib/tracerV2.ts) ──
    v2: {
      // Last-resort synthetic carries per shot-type bucket (R3/R4 rungs).
      priorCarries: { drive: 200, iron: 140, wedge: 60 },
      bagMountHeightM: 1.0, // replaces tripod 1.35; phone rides the bag
      estimatorVersion: 1, // bumped when the estimator changes (persisted/clip)
      allowPriorOnlyArc: true, // R4 (nothing usable) — dev-only escape hatch
    },
  },
  export: {
    defaultResolution: '1080p' as const,
    defaultFrameRate: 30 as const,
    resolutionOptions: ['720p', '1080p', '2k', '4k'] as const,
    frameRateOptions: [30, 60] as const,
  },
} as const;
