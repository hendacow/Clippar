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
  // golfCourseApi.key REMOVED — the course-search key now lives server-side, as
  // the GOLF_COURSE_API_KEY secret read by the search-courses edge function.
  //
  // Reading it here was the whole exposure. Expo's babel plugin inlines every
  // `process.env.EXPO_PUBLIC_*` reference as a string LITERAL at bundle time, and
  // this module is imported by ~15 app files, so the key shipped inside the
  // Hermes bundle of every build: `strings` the IPA and it falls out. That key
  // is a single 300-requests-per-day ACCOUNT-WIDE quota, so anyone holding it can
  // exhaust the day's allowance in one curl loop and kill course search for every
  // Clippar user, for free, daily.
  //
  // Nothing read this field — lib/golfCourseApi.ts now calls the proxy — so
  // deleting it is what actually removes the literal from the bundle. Leaving an
  // unread field here would have kept the key shipping while looking fixed.
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
    standardPriceCents: 9900,
    premiumPriceCents: 10900,
    currency: 'aud',
  },
  shop: {
    // Physical Clippar Mount kit (phone mount + Bluetooth clicker + portable
    // charger), sold on the website. Physical goods must NOT go through IAP
    // (App Review 3.1.3(e)) — every in-app surface links out to Safari.
    mountUrl: 'https://clippargolf.com/mount',
    mountPriceLabel: '$99',
    // Master switch for the mount cross-sell surfaces (post-signup offer +
    // record-tab card). OFF until the page's Stripe Payment Link is LIVE
    // (it currently carries a test-mode link — Stripe account activation
    // pending). The offer is one-shot per user, so it must never point at
    // a checkout that can't take money. Dev builds always show the
    // surfaces (see mountCommerceEnabled in lib/mountOffer.ts).
    mountCommerceEnabled: false,
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
    // with it off. OFF for the v1 production build — the tracer has not yet
    // passed a real-round field test, so prod ships stock behavior. Flip to
    // true (clippar-dev only) to resume field testing; originals are never
    // modified, so this is a pure on/off with no data risk.
    enabled: false as boolean,
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
  },
  export: {
    defaultResolution: '1080p' as const,
    defaultFrameRate: 30 as const,
    resolutionOptions: ['720p', '1080p', '2k', '4k'] as const,
    frameRateOptions: [30, 60] as const,
  },
} as const;
