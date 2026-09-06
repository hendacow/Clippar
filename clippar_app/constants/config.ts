// The ONLY import this module is allowed: a pure, dependency-free predicate.
// constants/config.ts is imported by ~15 app files AND by five node test files,
// so anything it pulls in has to work under `node --import tsx --test` with no
// React Native runtime. Relative, not `@/`, so resolution never depends on the
// test runner honouring tsconfig paths.
import { variantIsDev } from '../lib/proStatusLogic';

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
    // NO placeholder prices live here. There were two (monthlyPriceAud /
    // annualPriceAud) feeding the stub offering, and they were a standing
    // hazard on two counts: they were AUD, so a user on any other storefront
    // was shown Australian dollars for a product Apple charges them in their
    // own currency; and a hardcoded constant drifts from App Store Connect
    // silently (see APP_REVIEW_2026-08-04.md — config said A$14.99/A$99.99
    // while IAP_SETUP.md said A$19.99/A$149.00).
    //
    // Prices now come from exactly one place: the store-localised
    // priceString RevenueCat reports for the user's own storefront. When
    // that is unavailable the paywall says Pro is unavailable rather than
    // quoting a number nobody can stand behind. Do not reintroduce these.
    // When true, "Create Highlight Reel" requires an active subscription
    // (paywall shown otherwise — app/round/editor.tsx:925).
    //
    // OFF as of 2026-08-05, Henry's call: the whole reel pipeline — record,
    // detect, trim, compose, EXPORT — is free for v1. He hit his own gate on
    // a real round and the verdict was immediate: "it actually shouldn't
    // block anything." Pro still exists and still sells the thing it
    // genuinely gates: cloud backup (storage-settings + lib/uploadQueue are
    // the only remaining getProStatus gates in the app).
    //
    // THE PAYWALL COPY IS COUPLED TO THIS FLAG. When this was ON, both
    // paywall layers sold "unlimited reels / unlimited exports". With it OFF
    // those bullets sell what everyone gets free, so they were rewritten to a
    // cloud-backup pitch the same day. If you turn this back ON, restore the
    // reel/export bullets in app/paywall.tsx and app/paywall-trial.tsx or Pro
    // under-claims; if you copy old bullets back without turning this on,
    // Pro over-claims (3.1.2). Flag and copy move together, both directions.
    //
    // History: ON 2026-08-04 (gate needed something to sell once StoreKit
    // products existed); OFF before that (no completable paywall existed).
    // A reviewer-friendly side effect of OFF: App Review can exercise the
    // core flow with no entitlement at all.
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
    // The LIVE product page (Active and selling as of 31 Aug 2026).
    mountUrl: 'https://clippargolf.com/products/clippar-golf-kit',
    mountPriceLabel: '$99',
    // Master switch for the mount cross-sell surfaces (post-signup offer +
    // record-tab card). OFF until the page's Stripe Payment Link is LIVE
    // (it currently carries a test-mode link — Stripe account activation
    // pending). The offer is one-shot per user, so it must never point at
    // a checkout that can't take money. Dev builds always show the
    // surfaces (see mountCommerceEnabled in lib/mountOffer.ts).
    mountCommerceEnabled: false,
    // Master switch for the IN-APP hardware Shop — the Shop tab and every
    // route into it. A separate flag from mountCommerceEnabled above because
    // they gate different checkouts: that one is the website cross-sell, which
    // links out to Safari, while this one is the in-app Stripe PaymentSheet,
    // whose create-payment-intent + stripe-webhook functions are not deployed.
    // OFF for the v1 App Store launch: with them undeployed, Buy Now fails.
    //
    // This lives in config rather than as a local const in app/(tabs)/_layout.tsx
    // where it started, because `href: null` only removes the TAB BUTTON — the
    // route stays registered and `router.push('/(tabs)/shop')` reaches it
    // normally. So hiding the Shop is not one edit in the tab bar: every entry
    // point has to test the same flag, which means the flag has to be
    // importable. app/profile/orders.tsx is the entry point that got missed,
    // and it left App Review two taps from a storefront whose Buy Now errors.
    // Re-enabling post-launch is this one line, once those functions are live.
    inAppShopEnabled: false as boolean,
  },
  auth: {
    // Master switch for the "Continue with Google" BUTTON on the sign-in and
    // sign-up screens. Sign in with Apple and email/password are unaffected.
    //
    // OFF for v1, Henry's call (2026-08-05). Google sign-in routes through
    // Supabase's hosted callback, so Google's consent screen shows whatever the
    // Google Cloud OAuth app is named — currently not "Clippar". Two problems
    // follow, and only the second is actually dangerous:
    //
    //   1. A user (or an App Review tester) is asked to grant access to a name
    //      they have never heard of. Confusing, not fatal.
    //   2. While the OAuth consent screen is in "Testing" publishing status,
    //      ONLY allowlisted Google accounts can complete the flow at all. Every
    //      other user gets an error. That is a broken button shipped to
    //      production, and a reviewer who taps it sees the app fail.
    //
    // Guideline 4.8 is not a reason to keep it: 4.8 only applies when a
    // third-party login IS offered, and it is satisfied either way because Sign
    // in with Apple is present.
    //
    // This hides the button ONLY. `signInWithGoogle` stays wired in useAuth
    // because app/(tabs)/profile.tsx re-authenticates through it before account
    // deletion, and an already-Google-linked account still needs that path to
    // satisfy the in-app deletion App Review 5.1.1(v) requires.
    //
    // To re-enable: verify the OAuth consent screen in Google Cloud Console
    // (app name "Clippar", logo, support email), move publishing status from
    // Testing to In production, then flip this to true.
    googleSignInEnabled: false as boolean,
  },
  sharing: {
    // Master switch for PUBLIC SHARE LINKS — the "Create Share Link" action in
    // the share sheet, which uploads the stitched reel to Supabase Storage and
    // mints a permanent share_token that clippargolf.com/r/<token> resolves.
    //
    // OFF for v1, Henry's call (2026-08-04): a share link is only as permanent
    // as the storage bill behind it. Every link minted is a reel Clippar has to
    // hold forever, for a free user, with no way to reclaim the space without
    // breaking a link someone may have posted. Revisit as a Pro-only feature
    // where the storage is paid for.
    //
    // Nothing else in the share sheet touches the network: Save to Camera Roll,
    // Share Video and Instagram Stories all read the reel off local disk. With
    // this off, sharing is entirely device-local and `rounds.share_token` is
    // never written.
    //
    // It was already inert end-to-end and nobody had noticed: create-share-link
    // mints a token but never sets `is_published`, and get-shared-reel
    // (index.ts:126) refuses any round where `is_published !== true`. So every
    // link ever minted returned "not available" — this flag makes the UI honest
    // rather than changing what a user can actually do. DO NOT "fix" that by
    // restoring the storage RLS policy 013 dropped; migrations/019 documents
    // why that exposes every user's raw clips to any signed-in stranger.
    reelLinksEnabled: false as boolean,
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
    // defaultPreRollMs / defaultPostRollMs (3000/2000) and autoTrimEnabled
    // REMOVED — all three were read only by the Trim Settings screen, and none
    // of them reached anything that trims.
    //
    // The "defaults" were a lie by naming. The window every trim actually
    // resolves to is `windows.fullSwing` below (see resolveSavedTrimWindow),
    // but the settings screen seeded its pickers from defaultPre/PostRollMs and
    // so showed the user a 5.0s clip length this app has never produced. Two
    // names for "the default" is exactly how they drifted apart, so there is
    // now one: windows.fullSwing.
    //
    // autoTrimEnabled backed the "Auto-trim" switch. Nothing read it, and it
    // is gone rather than wired up because "off" is not a mode this pipeline
    // has: the single detectAndTrim call that trims a clip is also what marks
    // it processed (an unprocessed clip is filtered OUT of the reel — see
    // needsTrim in app/round/editor.tsx), what classifies putt-vs-swing for
    // hole auto-advance, and what supplies the impact time the manual trimmer
    // and the tracer anchor on. A switch labelled "auto-trim" that silently
    // costs a golfer their reel is worse than no switch. The pre/post pickers
    // below are the honest version of the same intent — up to 4s before and 5s
    // after impact keeps nearly the whole recording.
    durationPresets: [4000, 5000, 6000] as readonly number[], // 4s, 5s, 6s total
    // The values the two pickers in app/profile/trim-settings.tsx offer, in
    // ascending order. They live here so splitDurationPreset() can guarantee a
    // duration preset always lands on a chip the screen can highlight.
    preRollOptionsMs: [1000, 1500, 2000, 2500, 3000, 3500, 4000] as readonly number[],
    postRollOptionsMs: [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000] as readonly number[],
    // Per-context trim windows. `baseline` reproduces the historical 3000/2000
    // behavior; `fullSwing` is the tighter ~4s window (2500 pre + 1500 post)
    // and is the default every reader falls back to.
    // NOTE (fix #9): putts are floored to a minimum 4000ms TOTAL trim natively
    // — that floor lives in Swift, not here. Do not encode a fake 6000 value.
    //
    // That sentence was true of the intent and false of the code until now.
    // ShotDetectorModule.swift read `max(postRollMs, 4000)`, a floor on the
    // POST-ROLL, so a putt's clip was preRoll + 4000 rather than 4000 total: a
    // user-set 1000/1000 window ("2.0s" on the settings screen) produced a 5.0s
    // clip, and the default 2500/1500 window produced 6.5s. It now floors the
    // total, and reads the threshold from `detection.options.puttPostRollMs`
    // below so it is tunable — or removable with 0 — over the air.
    //
    // This matters well beyond actual putts: when pose detection finds no
    // confident swing, native's fallbackClassify labels ANY recording longer
    // than 12 seconds a putt at confidence 0.25, on duration alone.
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
    // SWING-VISION AUTO-TRIM. ON — this is the detector Henry asked to get back.
    //
    // WHY IT EXISTS. Every clip in the 2026-08-05 round came back
    // `strategy=baseline episodes=0 audioUsable=n conf=0.20-0.30`: the pose
    // state machine found no swing at all, audio was rejected, and
    // fallbackClassify guessed the impact instant from a rough audio
    // transient. The 2-second window was always exactly 2 seconds — the
    // WINDOW was never the bug. It was landing in the wrong place because
    // nothing had actually located the swing.
    //
    // swing-vision asks a different question. It finds WHEN by motion — the
    // energy dip where the club reverses at the top of the backswing, then
    // the clip's sharpest spike ~0.20s later on the downswing — and Core ML
    // only ever judges ~6 candidate moments rather than searching for the
    // instant itself. Measured on Henry's labelled clips: 41/42 instants
    // correct, 52/56 shot-vs-putt (see modules/swing-vision and
    // experiments/vision-swing-classifier/FINDINGS_V2.md).
    //
    // TURNING IT OFF IS ONE LINE AND NEEDS NO REBUILD. Set this to false and
    // the app reverts to the shot-detector path byte-for-byte — lib/visionTrim
    // returns null before touching native, which is the same route already
    // taken when the module or its model is missing from the build. Nothing
    // downstream can tell the difference.
    //
    // NOT YET VERIFIED ON A REAL ROUND. Every number above comes from a Mac
    // harness over recorded clips; no clip has been through this path on a
    // phone. If it disappoints in the field, flip this rather than debugging
    // under time pressure.
    swingVision: true as boolean,
    // Strategy tuning knobs forwarded to native as optionsJson. See
    // DetectionOptions in modules/shot-detector/index.ts for recognized keys.
    options: {
      // Putt trim floor, OFF. Henry's call 2026-08-05: a detected shot should
      // be the length the golfer asked for, full stop.
      //
      // Native floors a putt's trim window to this many ms. That would be
      // defensible if the classifier were reliable, but fallbackClassify
      // labels ANY recording longer than 12 seconds a putt on duration alone
      // (ShotDetectorModule.swift, `durationLong`) — so a driver filmed in a
      // 20-second recording comes back `putt` at confidence 0.25 and gets the
      // floor applied to it. The result was a 2.0s setting producing a 5.0s
      // clip, which is what made trim settings look broken for weeks.
      //
      // 0 disables the floor entirely: the requested window is always
      // honoured. Undetected shots are untouched either way — they keep the
      // full recording, which is the intended behaviour and lives on a
      // different branch (`!result.found`) that this does not affect.
      puttPostRollMs: 0,
    } as Record<string, unknown>,
  },
  tracer: {
    // Master kill switch. Every tracer code path (capture, GPS session, detect,
    // geometry, render, playback switching) is gated on this so the app is
    // byte-identical with it off. OFF for the v1 production build — the tracer
    // has not yet passed a real-round field test, so prod ships stock behavior.
    // Originals are never modified, so this is a pure on/off with no data risk.
    //
    // THE LITERAL HERE IS THE PRODUCTION VALUE. It is flipped to true, at module
    // load, for the DEVELOPMENT VARIANT ONLY — see the block below the config
    // object (`ENABLE_TRACER_ON_DEV_VARIANT`). That flip is why this stays a
    // plain literal rather than becoming a function call: tests/tracerClaims.ts
    // pins `enabled: <literal> as boolean` so the paywall/onboarding guards can
    // never silently become dead code, and constants/config.ts must stay
    // node-safe (five test files import it under `node --test`).
    enabled: false as boolean,
    // Which tracer pipeline runs. 'v1' is the shipped Vision-trajectory +
    // Bézier path (lib/tracerMath.ts + ShotTracer.swift); 'v3' is the physics
    // pipeline ported from ~/projects/clippar/tracer-lab (detector -> camera ->
    // RK4 flight -> bounded LM fit -> decision ladder -> polyline render).
    //
    // A SECOND knob rather than a replacement, deliberately: v3 can be turned
    // off in the field without losing v1, and with `enabled` on the two are a
    // genuine A/B on the same clips. Everything v3 adds is additive — v1 reads
    // no column and calls no native function that v3 introduces.
    engine: 'v3' as 'v1' | 'v3',
    // Sub-gate within `enabled` for compass-heading capture at record start.
    // V3 does NOT use heading for geometry (the fit gets its direction from the
    // pixels), but it is kept because it is free, already captured, and is the
    // only diagnostic that says which way the phone was pointing.
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

    // ── GPS session (V3). Consumed structurally by lib/gpsSession.ts ────────
    //
    // WHY A SESSION AND NOT A FIX. v1 took ONE getCurrentPositionAsync at
    // recording stop, and in the field that call returned a stale WiFi-anchored
    // position: two shots 80 m apart came back 4 cm apart, both claiming ±18 m,
    // because both resolved to the same router across a WiFi→4G handoff. The
    // carry collapsed to ~0 and every arc was silently skipped. These numbers
    // are the defence, and they are v2's (origin/tracer-v2, reviewed there) —
    // lib/gpsSession.ts carries the same values in DEFAULT_GPS_CONFIG as a
    // test-stable mirror, so if you retune here, retune there too or the tests
    // pin numbers the app no longer uses.
    gps: {
      // The first fixes after a cold start / AppState resume are junk. Excluded.
      warmupSec: 15,
      // STOP-anchor window. Wider look-back than the impact anchor because the
      // stop press is 1-3 s after the ball has gone and the setup dwell is
      // further back. (The IMPACT anchor's 15 s pre-window is a module constant
      // in lib/gpsSession.ts — it is not tunable and must not be.)
      windowPreSec: 25,
      windowPostSec: 10,
      // Widen the pre-window to here when the base window holds too few fixes.
      widenPreSec: 45,
      // m/s. Above this the golfer is walking, so the fix is not "at the ball".
      stationarySpeedMax: 0.7,
      // m. Drop fixes whose own reported horizontalAccuracy is worse than this.
      fixAccMax: 20,
      // Widen below this many accepted fixes; at the impact anchor, degrade to
      // no-fix rather than widen across a walk onto the bag.
      minFixes: 5,
      // m. Honest precision ceiling — no median of consumer GPS is better.
      effAccFloor: 2.5,
      // iOS horizontalAccuracy is optimistic; inflate before believing it.
      safetyFactor: 1.2,
      // No fix within this many seconds of the anchor -> 'gps-stale', never a
      // cached position. This rule is v1's bug's tombstone.
      staleSec: 10,
      // Health-chip thresholds (dev settings + record screen), metres of effAcc.
      tier1EffAccM: 5,
      tier2EffAccM: 10,
      // 1-sigma of where the phone actually sat relative to the ball at the
      // NEXT shot. This is the lab's CarryModel.bag_offset_m = 3.0
      // (tracer-lab/lib/fit.py), which is the authority for the name and value.
      bagOffsetM: 3,
    },

    // ── V3 pipeline knobs (lib/tracerV3.ts, the native detector, the render) ──
    //
    // Every number below is traceable to tracer-lab. Where the lab has a
    // constant, its name is quoted next to it so a value can be checked against
    // the source rather than taken on trust.
    v3: {
      // Detector: mean track confidence below this emits NOTHING (lab
      // detect.py P['conf_floor'] = 0.4 — every wrong output the vision skeptic
      // found had conf <= 0.33), and a track shorter than this many detections
      // is not emitted either (P['min_track_emit'] = 3).
      // IMPORTED AND PRE-TRACER CLIPS (Henry, 6 Sep). Every clip already on a
      // phone, and every clip imported from Photos, was recorded without the
      // capture geometry the fit needs: no lens/zoom columns, and no CoreMotion
      // pitch (both are only captured while the tracer is on). With this true
      // those clips are TRACED instead of refused, and can never state a
      // distance or an apex — the pill reads "no distance / camera unknown".
      //
      // Why the arc is still worth drawing without the number: the focal length
      // is degenerate in the fit (the physics skeptic measured the reprojection
      // error flat to 0.03 px across the whole +-12 % band while ball speed
      // moved 1:1), so an unknown scale moves the METRES and leaves the drawn
      // line on the ball. What it does move is the extrapolated tail and the
      // horizon the arc lands against — which is exactly why nothing is claimed.
      //
      // A KNOWN-bad geometry (an explicit 0.5x lens, a real pinch zoom) still
      // refuses: that scale is not unknown, it is wrong by up to 2x.
      traceUnknownGeometry: true,
      // Pitch assumed for a clip that carries none. Only consulted under
      // traceUnknownGeometry, and it forces the no-distance rung. A phone on a
      // bag mount or a tripod behind the ball sits a few degrees down; the lab's
      // eight calibrated clips ran -3.0 to +7.2 deg (experiments/camera).
      assumedPitchDownDeg: 4,
      detectConfFloor: 0.4,
      detectMinTrackEmit: 3,
      // Analysis window around impact, in 30 fps-equivalent frames, scaled by
      // the clip's real fps in Swift (lab P['pre_frames'] / P['post_frames']).
      detectPreFrames: 3,
      detectPostFrames: 45,
      // 0 = no ceiling on frames analysed. A ceiling exists only as an escape
      // hatch if a 4K60 clip proves too slow on an older phone; the lab
      // measured 8-33 ms/frame on a Mac and 1-3 ms/frame estimated in vImage.
      detectMaxFrames: 0,
      // Fit: LM iteration cap per solver stage (lib/tracerFit.ts default).
      // The lab runs 40 evaluations per multistart seed and up to 1000 on the
      // two survivors; the port's 200 is its own default and is what ships.
      fitMaxIterations: 200,
      // Fit the camera-pitch nuisance when the track is long AND passes the
      // image apex. OFF on short climbs, where the fit report (§3) measured it
      // moving the WRONG way. The ladder applies the same rule the lab does;
      // this only allows it at all.
      fitPitchAllowed: true as boolean,
      // 1-sigma of the CoreMotion camera pitch, degrees. Propagates 1:1 into
      // launch angle (skeptic-physics §3), so it is the floor on sigma(theta).
      pitchSigmaDeg: 0.5,
      // Cap a short or prior-driven fit whose apex/hang exceeds the club
      // bucket's physical maximum (lab render3 / tracer.py IMPLAUSIBLE_*).
      // IMG_3626's 3 detections fitted 71.8 m/s, a 53.7 m apex and 8.2 s of
      // hang before this rung existed.
      implausibleCap: true as boolean,
      // Hold the last source frame so a flight that outlasts the clip still
      // lands, instead of the trace being cut mid-air (lab render3 §4).
      freezeComplete: true as boolean,
      freezeTailSec: 0.6,
      freezeMaxSec: 6.0,
      // Person segmentation hides the trace behind the golfer
      // (VNGeneratePersonSegmentationRequest; lab render2/e2e2 §2 measured a
      // 76-89 % drop in trace pixels on the body).
      occlusion: true as boolean,
      // Round the pill's carry to the fit's own honest step (1 / 5 / 10 m from
      // sigma_total['carry_m'], which includes the f_px systematic). OFF shows
      // the unrounded metre, which over-claims precision — dev diagnosis only.
      labelRounding: true as boolean,
      // DEV OFF-SWITCH for the ladder's refusals, so a street test with no club
      // and no ball still produces an arc. Bypasses: putt / not-a-flight,
      // track-not-ballistic, poor-fit and the never-climbs check. Does NOT
      // bypass "there are no detections" or "there is no address ball" — those
      // are absences of input, not judgements, and there is nothing to draw.
      // MUST be false for a real round: it will draw arcs over putts.
      forceTrace: false as boolean,
    },
  },
  export: {
    defaultResolution: '1080p' as const,
    defaultFrameRate: 30 as const,
    resolutionOptions: ['720p', '1080p', '2k', '4k'] as const,
    frameRateOptions: [30, 60] as const,
  },
} as const;

// ── Tracer: dev-variant enablement ──────────────────────────────────────────
//
// Henry's brief, 6 Sep 2026: "integrate this into the app FOR THE DEV BUILD but
// make it a config so it's super easy to revert". So the tracer must be on in
// "Clippar Dev" and off in every binary that can reach a customer, and the
// revert must be one line.
//
// WHY THIS IS A POST-DEFINITION FLIP AND NOT A COMPUTED PROPERTY. Three
// constraints meet here and only this shape satisfies all three:
//
//  1. `constants/config.ts` must stay NODE-SAFE. Five test files import it
//     under `node --import tsx --test`, where `expo-constants` cannot be
//     resolved at all. So the variant read has to be a guarded require that
//     degrades to "not dev", not a static import.
//  2. `tests/tracerClaims.test.ts` pins `enabled: <literal> as boolean` in the
//     SOURCE TEXT. That test exists so that renaming the key can never turn the
//     paywall/onboarding guards into dead code while the copy keeps selling a
//     tracer the binary does not ship (App Review 3.1.2). Turning `enabled`
//     into a call expression would break it, and weakening it to accommodate
//     this file would remove exactly the protection it was written for.
//  3. Ordering must be unambiguous. It is: an ES module's body runs to
//     completion before any importing module's body starts, so every consumer
//     of `config.tracer.enabled` — including modules that read it at their own
//     top level, like `lib/gpsSession.ts`'s singleton — sees the flipped value.
//     There is no "who imported first" hazard.
//
// FAIL-CLOSED, and double-gated exactly as lib/devPro.ts is, for the same
// reason. `extra.variant` is stamped at PUBLISH time, so a stray
// `APP_VARIANT=development eas update --branch production` would push a
// dev-variant manifest into every App Store install; the manifest check alone
// would then switch the tracer on for real users, and the one thing they would
// SEE is a location permission dialog. The native bundle identifier is baked
// into the binary and no OTA can change it, so a production binary that
// receives a dev-variant manifest still reads NOT dev.
//
// THE ONE-LINE REVERT: set this to false. Nothing flips, `config.tracer.enabled`
// stays the `false` literal above in every binary — no GPS session, no
// detection, no render, and no UI reachable by tapping.
//
// Said precisely, because "byte-identical" was overstated and the review caught
// it (docs/tracer-v3/review.md, F9 and F10). SIX things survive the revert.
//
// It said FOUR until 6 Sep and the list stopped at item 4 — the gate agent read
// it against the code and found the count short (GATE-3, docs/tracer-v3/gate.md).
// That is the SECOND time this comment has drifted (gate NEW-3 was the first), so
// items 5 and 6 are spelled out here rather than left to the documents that
// already disclose them, because a comment that reads as exhaustive and is not is
// worse than no list: the first four are the JS layer, and the binary payload and
// the module singleton are not in it.
//
//  1. `app/profile/tracer-dev-settings.tsx` is an expo-router route file, so
//     `/profile/tracer-dev-settings` is REGISTERED in every binary including
//     production, even though the row that pushes it is gated away.
//  2. The schema migration is one flag-independent list, so the tracer's columns
//     are added to every database and reverting does not remove them.
//  3. `capture_lens` and `capture_zoom` are WRITTEN, non-null, on every clip
//     save, with the tracer off. This corrects what this comment said until
//     6 Sep, which was that `saveLocalClip` binds them to NULL — the same change
//     set that added them deliberately left them UNGATED (`hooks/useCamera.ts`,
//     review F3a), and the two files disagreed for a round (gate NEW-3).
//     Deliberate, and the reason is worth keeping: a clip saved without those
//     two values is one the V3 ladder must refuse FOREVER, because "unknown
//     lens" and "1x" are the same input to every calculation downstream and only
//     one of them is safe. Gating them behind the flag would silently poison
//     every clip recorded before the flag was flipped. They are two nullable
//     columns, nothing reads them with the tracer off, and they contain no
//     location, no identifier and nothing about the golfer.
//  4. One navigation focus subscription and one state object per mount of the
//     record screen (review F11).
//  5. `lib/gpsSession.ts` constructs its module-level `gpsSession` singleton on
//     import, unconditionally — the flag is read INSIDE it, not around it
//     (review F11's second half). It allocates one object and starts nothing:
//     every location call lives in `startWatch`, below `hooks/useGpsSession.ts`'s
//     `isActive` early return.
//  6. The native payload ships in every binary regardless of the flag (review
//     F12): the 5.9 MB `GolfBallDetector.mlpackage` resource bundle and the
//     `CoreML` framework link, both in `modules/shot-detector/ios/
//     ShotDetector.podspec`, plus the `detectShotV3` and `renderTracerV3`
//     `AsyncFunction` registrations in `ShotDetectorModule.swift`. Model loading
//     is lazy, so with the flag off the `.mlpackage` is never compiled or read —
//     it is bytes on disk and in the download, not work.
//
// None of it executes work, prompts the user or touches a hot path, and only
// item 3 writes anything — but it is not nothing, and rounding it to
// "byte-identical" is how a claim in a comment stops being true.
const ENABLE_TRACER_ON_DEV_VARIANT = true;

/**
 * `expo-constants` / `expo-application`, or undefined where they cannot load.
 *
 * A guarded `require` rather than an import: Metro resolves a literal-string
 * require statically so the device build is unaffected, while node throws
 * (`expo-modules-core` ships TypeScript sources) and we catch it. Both failure
 * modes land on the same answer — "cannot prove this is the dev variant" — and
 * that answer is the safe one.
 */
function readOptionalNativeModule(name: 'expo-constants' | 'expo-application'): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return name === 'expo-constants' ? require('expo-constants') : require('expo-application');
  } catch {
    return undefined;
  }
}

/** app.config.js `extra.variant` for this binary; undefined off-device. */
function readAppVariant(): string | undefined {
  const mod = readOptionalNativeModule('expo-constants') as
    | { default?: { expoConfig?: { extra?: { variant?: unknown } } }; expoConfig?: { extra?: { variant?: unknown } } }
    | undefined;
  const constants = mod?.default ?? mod;
  const variant = constants?.expoConfig?.extra?.variant;
  return typeof variant === 'string' ? variant : undefined;
}

/** Native bundle identifier; undefined off-device or on a binary too old to
 *  carry expo-application. Null from the module means "no native module". */
function readBundleId(): string | undefined {
  const mod = readOptionalNativeModule('expo-application') as
    | { default?: { applicationId?: unknown }; applicationId?: unknown }
    | undefined;
  const application = mod?.default ?? mod;
  const id = application?.applicationId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Whether this binary is allowed to run the tracer. Pure, so the fail-closed
 * rules are unit-testable without a device (tests/tracerV3Wiring.test.ts).
 *
 * `bundleId === undefined` is NOT treated as a failure: it is what a build
 * predating expo-application, or a web bundle, reports, and in those contexts
 * the manifest check is the pre-hardening behaviour and is all there is. It is
 * unreachable from a store binary, which always has an applicationId.
 */
export function tracerAllowedOnBinary(
  variant: string | null | undefined,
  bundleId: string | null | undefined
): boolean {
  if (!variantIsDev(variant)) return false;
  if (typeof bundleId === 'string' && !bundleId.endsWith('.dev')) return false;
  return true;
}

if (ENABLE_TRACER_ON_DEV_VARIANT && tracerAllowedOnBinary(readAppVariant(), readBundleId())) {
  // `config` is `as const`, so this needs a cast. The dev-settings screen
  // (app/profile/tracer-dev-settings.tsx) mutates config.tracer the same way,
  // which is how its toggles take effect without a rebuild.
  (config.tracer as { enabled: boolean }).enabled = true;
}

// ── Trim window resolution ───────────────────────────────────────────────────
//
// ONE implementation, because two readers must never disagree.
// hooks/useCamera.loadTrimSettings resolves the window for live capture and
// hooks/useEditorState.getTrimSettings resolves it for import re-trims. Those
// two used to be hand-mirrored copies with comments asking the next person to
// keep them in step. If they ever answer differently for the same stored value,
// a clip re-trimmed in the editor silently differs from the one that was
// recorded — and nobody finds out until the round is over and unrepeatable.
//
// WHY THE MARKER EXISTS. FIX #8 moved the default window from 3000/2000 to the
// tighter fullSwing 2500/1500. Overrides saved before that change carry the old
// numbers, and honouring them would have kept day-zero users pinned to the old
// length forever, so both readers began accepting a stored override ONLY when
// it carried `window: 'fullSwing'`.
//
// WHY THAT MADE THINGS WORSE. The Trim Settings screen was never taught to
// write the marker. So a guard meant to ignore STALE overrides ignored EVERY
// override, including the one the user set thirty seconds ago: both pickers and
// all three duration presets wrote to storage, reported success, and changed
// nothing. Every clip trimmed to 2500/1500 regardless of what was on screen.
//
// THE CONTRACT, therefore: app/profile/trim-settings.tsx must stamp
// TRIM_WINDOW_MARKER on every save, and must read its initial values back
// through resolveSavedTrimWindow so the numbers it shows are the numbers the
// pipeline will trim to. Drop either half and the controls go dead again, just
// as quietly as last time.

/**
 * Schema marker stamped on every trim override written by the settings UI.
 *
 * It reads like a description of the chosen length but it is not one — a user
 * who picks 6s still gets `window: 'fullSwing'`. What it actually means is
 * "this blob was written by a build that knows fullSwing is the baseline", and
 * that is the only thing the readers need to distinguish a deliberate choice
 * from a pre-FIX-#8 leftover. The literal is unchanged from the original guard
 * so no stored value changes meaning.
 */
export const TRIM_WINDOW_MARKER = 'fullSwing';

/** Smallest roll either picker in app/profile/trim-settings.tsx can write. */
export const MIN_TRIM_ROLL_MS = 1000;
/** Generous ceiling above the largest picker option (5000). */
export const MAX_TRIM_ROLL_MS = 10_000;

export interface TrimWindow {
  preRollMs: number;
  postRollMs: number;
}

/**
 * Coerce one stored roll value into something safe to hand to the native
 * trimmer.
 *
 * A round is recorded once, on a course, and cannot be re-recorded, so every
 * branch here leans toward KEEPING footage:
 *  - anything that is not a finite number (missing, null, "2500", NaN) falls
 *    back to the config window, never to 0 — native reads 0 as "keep nothing
 *    on that side of impact", which is the one outcome that destroys a swing;
 *  - anything below the smallest value the UI can produce is treated as
 *    corruption rather than intent, because honouring it would trim MORE than
 *    the user ever asked for;
 *  - anything absurdly large is clamped rather than discarded, since clamping
 *    keeps more of the clip than reverting to the default would.
 */
function sanitizeRollMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackMs;
  const ms = Math.round(value);
  if (ms < MIN_TRIM_ROLL_MS) return fallbackMs;
  return Math.min(ms, MAX_TRIM_ROLL_MS);
}

/**
 * The window the USER chose: config.trim.windows.fullSwing, replaced by a
 * stored override only when that override carries TRIM_WINDOW_MARKER.
 *
 * This is what the settings screen displays and edits. It deliberately does NOT
 * include the tracer's extra post-roll — see resolveEffectiveTrimWindow.
 *
 * @param saved raw `trim_settings` value straight out of local_settings.
 */
export function resolveSavedTrimWindow(saved: string | null | undefined): TrimWindow {
  const base = config.trim.windows.fullSwing;
  if (!saved) return { preRollMs: base.preRollMs, postRollMs: base.postRollMs };
  try {
    const parsed: unknown = JSON.parse(saved);
    // Untagged blob → written before FIX #8 (or by something else entirely).
    // Ignored on purpose: it would otherwise shadow the tighter default.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { window?: unknown }).window !== TRIM_WINDOW_MARKER
    ) {
      return { preRollMs: base.preRollMs, postRollMs: base.postRollMs };
    }
    const o = parsed as { preRollMs?: unknown; postRollMs?: unknown };
    return {
      preRollMs: sanitizeRollMs(o.preRollMs, base.preRollMs),
      postRollMs: sanitizeRollMs(o.postRollMs, base.postRollMs),
    };
  } catch {
    // Truncated / non-JSON value. Keep the default window rather than guessing.
    return { preRollMs: base.preRollMs, postRollMs: base.postRollMs };
  }
}

/**
 * The window the PIPELINE trims to: the user's window plus the tracer's extra
 * post-roll when the tracer is on.
 *
 * Both readers (live capture and import re-trim) call exactly this, so they
 * cannot drift. The tracer bonus is added here and not in
 * resolveSavedTrimWindow so the settings screen never round-trips it back into
 * storage — doing that would add it a second time on the next read, growing the
 * post-roll on every save.
 */
export function resolveEffectiveTrimWindow(saved: string | null | undefined): TrimWindow {
  const { preRollMs, postRollMs } = resolveSavedTrimWindow(saved);
  // No-op at the default 0: a longer post-impact window keeps more ball flight
  // in the trimmed clip for the arc draw-on. Gated on config.tracer.enabled so
  // day-zero behavior is byte-identical.
  if (config.tracer.enabled && config.tracer.extraPostRollMs > 0) {
    return { preRollMs, postRollMs: postRollMs + config.tracer.extraPostRollMs };
  }
  return { preRollMs, postRollMs };
}

/**
 * Split a duration preset (4s / 5s / 6s) across the two pickers.
 *
 * Two rules, both about the screen telling the truth:
 *  1. The result must be a value the pickers can SHOW. The old split (40% pre /
 *     60% post) produced 1600/2400 for the 4s preset — numbers no chip offers —
 *     so tapping a preset left both rows with nothing highlighted.
 *  2. When a preset cannot be hit exactly on the chip grid, round UP. A clip
 *     that kept 200ms more than the label promised is a non-event; one that
 *     kept 200ms less has thrown away footage from a round that happens once.
 *
 * The 62/38 lean matches config.trim.windows.fullSwing (2500/1500) — more
 * before impact than after — so the 4s preset reproduces the app's own default
 * instead of quietly re-splitting it into a different 4 seconds.
 */
export function splitDurationPreset(totalMs: number): TrimWindow {
  const pre = config.trim.preRollOptionsMs;
  const post = config.trim.postRollOptionsMs;
  const preRollMs = nearestOption(pre, Math.round(totalMs * 0.62));
  const postRollMs = atLeastOption(post, totalMs - preRollMs);
  return { preRollMs, postRollMs };
}

/** Closest option to `targetMs`; ties go to the smaller one. */
function nearestOption(options: readonly number[], targetMs: number): number {
  return options.reduce((best, o) =>
    Math.abs(o - targetMs) < Math.abs(best - targetMs) ? o : best
  );
}

/** Smallest option >= `targetMs` (options ascending), else the largest. */
function atLeastOption(options: readonly number[], targetMs: number): number {
  return options.find((o) => o >= targetMs) ?? options[options.length - 1];
}
