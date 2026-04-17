# Clippar Pitch Deck Brief

> Use this document as the complete context for creating a Clippar investor/partner pitch deck. It covers the product, how it works technically, the market, competitors, financials, marketing plan, and virality thesis.

---

## 1. WHAT IS CLIPPAR

Clippar is a mobile app that turns a casual golfer's round into a shareable highlight reel — automatically. The golfer just plays. Clippar records each shot, uses on-device AI to detect the swing impact, auto-trims to the 5-second window around contact, composes a highlight reel with a live scorecard overlay and music, and lets the player share it to Instagram, WhatsApp, or group chats in one tap.

**One-liner:** "GoPro meets golf, but it edits itself."

**Target user:** The 25-55 year old social/casual golfer who plays weekly, cares about their score, and already shares golf content in group chats and on Instagram. They're NOT tour pros. They're the Saturday morning foursome.

---

## 2. HOW IT WORKS (for a non-technical audience)

### The Player Experience
1. **Mount phone on the buggy** using the Clippar mount ($59 AUD kit)
2. **Select the course** — Clippar auto-loads hole-by-hole pars from 30,000+ courses worldwide
3. **Hit the shot clicker** (BLE button on their belt) or tap the screen after each shot
4. **Play the round normally** — Clippar records in the background
5. **After the round**: Open the app, tap "Make Reel"
6. **Clippar does the rest**: AI finds each swing, trims to the best 5 seconds, stitches clips together, overlays the scorecard (hole number, par, strokes, running total), adds music
7. **Share**: One tap to Instagram Stories, WhatsApp group, save to camera roll

### What Makes This Hard (and why nobody's done it well)
- **Swing detection on a phone**: Clippar uses Apple Vision pose estimation + audio transient analysis to find the exact frame of club-ball contact. Not a generic "motion detector" — it's a 3-phase state machine (IDLE → SETUP → SWING → BALL_MOVED) trained specifically for golf swings vs putts vs penalties.
- **Scorecard overlay**: The reel doesn't just show clips — it shows a live-updating scorecard that tracks the player's score hole by hole, against par. This makes the reel feel like a sports broadcast, not a home video.
- **On-device processing**: Detection runs on-device (no internet needed during the round). The phone's Neural Engine handles it in under 2 seconds per clip.

---

## 3. TECH ARCHITECTURE (for technical due diligence)

| Layer | Tech | Purpose |
|-------|------|---------|
| **Mobile app** | React Native (Expo SDK 54), TypeScript | Cross-platform (iOS first, Android-ready) |
| **Native modules** | Custom iOS Swift module (Apple Vision, AVFoundation, Core ML) | Pose detection, video trimming, reel composition |
| **Local storage** | expo-sqlite | Offline-first clip metadata, scores, trim state |
| **Backend** | Supabase (PostgreSQL + Auth + Storage + Edge Functions) | User accounts, cloud storage, API |
| **Cloud storage** | Supabase Storage (Cloudflare R2) with TUS resumable uploads | Clip and reel hosting |
| **GPU pipeline** | Modal Labs (serverless Python on A100 GPUs) | Server-side reel generation for premium tier |
| **Payments** | Stripe (in-app PaymentSheet + webhooks) | Subscriptions and hardware sales |
| **Course data** | GolfCourseAPI.com (30K+ courses, hole-by-hole pars) | Auto-populate course/par data |
| **Hardware** | BLE shot clicker (HID profile, CR2032, 12-month battery) | One-tap shot marking without touching the phone |

### AI Detection Algorithm
- **YOLOv8n-pose** (17-point skeleton) for golfer posture detection
- **3-phase state machine**: detects stance setup, swing motion (wrist velocity >50 deg/frame), ball displacement confirmation
- **Audio fallback**: 1200Hz high-pass filter isolates club impact sound, confirms swing timing
- **Confidence scoring**: hybrid pose+audio yields 0.0-1.0 confidence per detected swing
- **Trim window**: 3 seconds before impact, 2 seconds after (5s total, configurable)
- **Runs on-device** in <2s per clip on iPhone 12+ Neural Engine

---

## 4. BUSINESS MODEL

### Revenue Streams

| Stream | Price (AUD) | Margin | Notes |
|--------|-------------|--------|-------|
| **Monthly subscription** | $19.99/mo | ~95% | Unlimited cloud processing, reel generation, priority queue |
| **Annual subscription** | $149/yr ($12.42/mo) | ~95% | Same features, 38% discount vs monthly |
| **Standard Hardware Kit** | $59 | ~60% | Buggy phone mount + BLE shot clicker |
| **Premium Hardware Kit** | $69 | ~55% | Standard + 15W MagSafe wireless charger |

### Free Tier
- Record rounds, import clips, local clip library
- 2 cloud processing jobs per day
- No highlight reel composition
- Designed to let users experience recording + detection before hitting the paywall on the reel

### Unit Economics (Target)
| Metric | Target |
|--------|--------|
| **CAC** (Customer Acquisition Cost) | $15-25 AUD via golf influencer partnerships |
| **LTV** (Lifetime Value, 12-month) | $149-240 AUD (annual sub or 12x monthly) |
| **LTV:CAC ratio** | 6-16x |
| **Hardware attach rate** | 40-60% of subscribers (one-time revenue + retention anchor) |
| **Monthly churn** | Target <5% (golf is seasonal — winter churn expected, re-activation in spring) |

---

## 5. MARKET OPPORTUNITY

### Total Addressable Market
- **66 million golfers** worldwide (National Golf Foundation, 2024)
- **3.4 million** in Australia/NZ (Golf Australia)
- **25.6 million** in USA (NGF)
- **Post-COVID golf boom**: participation up 20% since 2020, especially 18-34 demographic
- **Social golf growing fastest**: 44% of new golfers are "non-traditional" (TopGolf, simulators, social rounds)

### Serviceable Market
- Golfers who **own a smartphone** and **play 10+ rounds/year**: ~30 million globally
- Golfers who **already share golf content** on social (Instagram, TikTok, WhatsApp groups): ~12 million
- Golfers who **would pay $20/mo** for a tool that automates highlight reels: ~2-4 million (based on Arccos/Shotscope adoption curves)

### Why Now
1. **Phone cameras are finally good enough**: iPhone 12+ shoots 4K60, Neural Engine handles real-time pose estimation
2. **Social sharing is the default**: 73% of millennials share sports content on social media (Morning Consult 2023)
3. **Golf content is exploding**: #golf has 15B+ views on TikTok, golf YouTubers (Good Good, Rick Shiels) have 10M+ subscribers
4. **Wearable fatigue**: Golfers are tired of $300+ GPS watches that track stats but don't create shareable content. Nobody watches a spreadsheet.

---

## 6. COMPETITIVE LANDSCAPE

### Direct Competitors

| Product | What They Do | Price | Weakness |
|---------|-------------|-------|----------|
| **Arccos Golf** | GPS shot tracking via sensors in grip caps | $199/yr + $179 sensor set | No video. Stats-only. Sensor battery issues. No social sharing of actual shots. |
| **Shot Scope** | GPS watch + automatic shot tracking | $299 device + $99/yr | No video. Ugly interface. Stats-only. Niche audience. |
| **V1 Golf (Swing Catalyst)** | Swing analysis via slow-mo video | $29.99/mo | Single-swing tool, NOT round-based. Manual upload per swing. Coaching-focused, not social. |
| **Hudl Technique** | General sports slow-mo analysis | Free-$9.99/mo | Not golf-specific. No scorecard. No reel composition. No course integration. |
| **18Birdies** | GPS rangefinder + scoring | Free-$99/yr | GPS and scoring only. No video capture. No AI. No reels. |
| **Garmin Golf** | GPS watch ecosystem + stats | $299+ watch + app | No video. Stat dashboards only. Expensive hardware lock-in. |
| **GolfShot** | GPS + scoring + club recommendations | Free-$39.99/yr | No video. No AI. Score-focused. |

### Indirect Competitors

| Product | Overlap | Why Clippar Wins |
|---------|---------|-----------------|
| **GoPro + manual editing** | Golfers already mount GoPros on buggies | 2-4 hours of manual editing per round. Nobody does it twice. Clippar does it in 60 seconds. |
| **iPhone + iMovie** | The DIY approach | Manual trimming, no swing detection, no scorecard overlay. Too slow for weekly use. |
| **Instagram Reels editor** | Social platform native editing | No golf-specific features. No auto-trim. No scorecard. Requires manual clip selection. |
| **TikTok** | Some golfers post raw clips | No round structure. No scoring. No auto-detection. Just raw clips with text overlays. |

### Competitive Moat
1. **Swing detection IP**: 3-phase state machine with pose + audio hybrid. Not a generic motion detector — golf-specific, trained on swing biomechanics.
2. **Scorecard integration**: Connected to 30K+ real courses with hole-by-hole par data. No competitor shows a live scorecard on video.
3. **Hardware bundle**: Physical mount + clicker creates switching cost and improves experience (vs. app-only competitors who are one-tap-uninstall away).
4. **Network effects**: When one player in a foursome shares a Clippar reel, the other three see it and want their own. Golf is inherently social and played in groups.

---

## 7. VIRALITY THESIS — WHY THIS SPREADS ON ITS OWN

### The Golf Group Chat Loop

Golf has a unique social structure that makes Clippar inherently viral:

1. **Golf is played in groups of 2-4.** Every round has a built-in audience.
2. **Every group has a chat.** WhatsApp, iMessage, or Facebook Messenger group for the weekly foursome.
3. **Golfers already share clips and scores.** But they're bad — shaky phone video, no context, no scorecard.
4. **Clippar reels look professional.** Music, scorecard overlay, auto-trimmed to the good shots. They look like a mini sports broadcast.
5. **The first person who shares a Clippar reel to the group gets asked "how did you make that?"** The answer is the app name: Clippar.
6. **The other 3 players download it before the next round.** Because nobody wants to be the only one WITHOUT a highlight reel.

### Virality multiplier math
- **Average foursome**: 4 players
- **Average golfer plays with**: 8-12 unique partners per season
- **If 1 player shares a reel**: 3 players see it per round
- **Conversion rate (see reel → download app)**: estimated 30-50% (golf is competitive + social)
- **K-factor**: 1 user can generate 3-6 new downloads per season organically

### Additional viral vectors
- **Instagram Stories/Reels**: Clippar reels have the Clippar watermark. Golfer posts highlight reel → followers see it → "what app is that?"
- **Club competitions**: Golf clubs run weekly and monthly competitions. If one member starts sharing Clippar reels, the entire club sees them on the social feed.
- **Golf influencers**: A single golf YouTuber/TikToker using Clippar in a video exposes it to 100K-1M golf-specific viewers.
- **Course pro shops**: Hardware kits sold through pro shops = physical presence at point of play + staff recommendations.
- **"My mate uses it"**: Golf is one of the few sports where word-of-mouth is the #1 discovery channel for gear and apps (Golf Digest survey 2023).

### Why This Doesn't Work for Other Sports
- **Tennis**: Played 1v1, less social sharing culture
- **Running**: Solo activity, no clips to share
- **Team sports**: Too many players, camera angle problems
- **Golf is uniquely perfect**: Small groups, stationary shots, social culture, long time between shots (time to check phone), established group chat behavior

---

## 8. MARKETING PLAN

### Phase 1: Seed (Months 1-3) — "Prove it works"
| Channel | Action | Budget | Goal |
|---------|--------|--------|------|
| **Organic social** | Post Clippar reels from real rounds to Instagram/TikTok (@clippar.golf) | $0 | Build content library, prove product quality |
| **Golf group infiltration** | Give free Premium accounts to 50 "golf group leaders" (the organiser in every WhatsApp group) | ~$500 (cost of hosting) | Seed the group chat loop. If the organiser uses it, the group follows. |
| **Local clubs (AU)** | Partner with 5-10 golf clubs in Melbourne/Sydney for "Clippar Day" — free trial + hardware demo | $2-5K | Drive initial hardware sales + subscriptions from engaged club members |
| **Reddit/forums** | Post reels and behind-the-scenes dev content in r/golf, GolfWRX, OzBargain | $0 | Organic awareness in golf-obsessed communities |

### Phase 2: Grow (Months 4-9) — "Golf influencer flywheel"
| Channel | Action | Budget | Goal |
|---------|--------|--------|------|
| **Golf YouTubers/TikTokers** | Send free Premium kit to 20-30 mid-tier golf influencers (10K-200K followers). No script — just "use it for a round and post if you like it." | $5-10K (hardware + shipping) | Authentic content from trusted voices. Golf influencer audiences are highly engaged and purchase-ready. |
| **Paid social (Meta/TikTok)** | Retarget users who watched a Clippar reel. Show "See your round like this" ads with real user-generated reels. | $5-15K/mo | 1,000-3,000 app installs/month at $5-15 CAC |
| **Golf podcast sponsorship** | Sponsor 2-3 popular golf podcasts (e.g. No Laying Up, The Fried Egg, Aus Golf Digest) | $2-5K/mo | Reach dedicated golfers who listen weekly during commutes |
| **Pro shop partnerships** | Place hardware kits in 20-50 pro shops across AU (consignment or wholesale) | $3-5K initial inventory | Physical product = trust signal. Staff demo the app during fittings. |

### Phase 3: Scale (Months 10-18) — "International expansion"
| Channel | Action | Budget | Goal |
|---------|--------|--------|------|
| **US launch** | Localise pricing (USD $14.99/mo), expand GolfCourseAPI coverage, partner with US golf influencers | $20-50K | Tap the 25.6M US golfer market |
| **App Store Optimization** | Keyword targeting ("golf highlight reel", "golf video editor", "golf scorecard"), featured in Sports category | $2-5K (ASO tools) | Organic discovery for high-intent searchers |
| **Referral program** | "Give 1 month free, get 1 month free" for every friend who subscribes | Cost of 1 month hosting per referral | Accelerate the group chat loop with financial incentive |
| **Corporate/event** | Sell "Clippar Event Mode" for charity golf days, corporate outings (bulk accounts, branded overlays) | Custom pricing | B2B revenue stream + mass exposure at events with 100+ players |

---

## 9. FINANCIAL PROJECTIONS (18-MONTH)

### Assumptions
- Launch in Australia first, US expansion at month 10
- Subscription: $19.99/mo AUD or $149/yr AUD
- Hardware: $59-69 AUD per kit
- Monthly churn: 6% (seasonal, improving to 4% by month 12)
- Organic viral growth: K-factor 0.3 in months 1-6, 0.5 in months 7-18

### Revenue Model

| Month | Paid Subscribers | Hardware Kits Sold | MRR (AUD) | Hardware Rev (AUD) | Total Rev (AUD) |
|-------|------------------|--------------------|-----------|-------------------|-----------------|
| 1 | 50 | 30 | $999 | $1,770 | $2,769 |
| 3 | 200 | 100 | $3,998 | $5,900 | $9,898 |
| 6 | 800 | 350 | $15,992 | $20,650 | $36,642 |
| 9 | 2,000 | 600 | $39,980 | $35,400 | $75,380 |
| 12 | 5,000 | 1,200 | $99,950 | $70,800 | $170,750 |
| 15 | 10,000 | 2,000 | $199,900 | $118,000 | $317,900 |
| 18 | 20,000 | 3,500 | $399,800 | $206,500 | $606,300 |

### Cost Structure (Monthly at 5,000 subs)

| Cost | Monthly (AUD) | Notes |
|------|--------------|-------|
| Supabase (Pro) | $75 | Database, auth, storage (R2 is cheap) |
| Modal GPU pipeline | $500-2,000 | Pay-per-job, ~$0.10-0.40 per reel |
| Stripe fees (2.9%+30c) | ~$3,000 | Per transaction |
| GolfCourseAPI | $0 (free tier) | 30K courses, rate-limited |
| Apple Developer | $149/yr | App Store listing |
| Hardware COGS | ~$25/kit | Mount + clicker + packaging + shipping |
| Marketing | $10-20K | Influencers, paid social, events |
| **Total** | **~$18-28K** | At 5K subscribers |
| **Gross margin** | **~72-82%** | Software-heavy, hardware margin ~55-60% |

### Key Metrics to Track
- **Reels created per user per month** (engagement proxy)
- **Share rate** (% of reels shared externally)
- **Viral coefficient** (new installs attributable to shared reels)
- **Hardware attach rate** (% of subscribers who buy a kit)
- **Day 7 / Day 30 retention** (golf is weekly — D7 is the magic number)
- **Rounds recorded per subscriber** (usage = retention)
- **Seasonal churn curve** (expect winter dip, spring rebound)

---

## 10. SLIDE OUTLINE FOR THE DECK

1. **Title Slide** — Clippar logo, tagline: "Your golf. Highlight reel. Automatic."
2. **The Problem** — Golfers already record and share, but manual editing takes hours. Nobody does it more than once.
3. **The Solution** — Demo reel (30-second embedded video of a real Clippar highlight reel with scorecard overlay)
4. **How It Works** — 4-step visual: Mount → Play → Auto-Detect → Share
5. **The Tech** — On-device AI swing detection (pose + audio), scorecard overlay, one-tap composition. Diagram of the pipeline.
6. **Demo / Screenshots** — App screenshots showing: recording screen, editor with clips, completed reel with scorecard
7. **Market Opportunity** — 66M golfers worldwide, golf content exploding on social, post-COVID participation boom
8. **Competitive Landscape** — 2x2 matrix: (Video vs Stats-only) x (Automated vs Manual). Clippar is the only player in the "Automated Video" quadrant.
9. **Why This Goes Viral** — The group chat loop diagram. One player shares → three see it → three download → multiplied across 8-12 playing partners per season.
10. **Business Model** — Subscription ($19.99/mo) + Hardware ($59-69 kits) + Future B2B (events, branded reels)
11. **Traction / Metrics** — Current stats: users, rounds recorded, reels created, share rate (populate with real numbers)
12. **Financial Projections** — 18-month revenue ramp, path to $600K ARR
13. **Go-to-Market** — Phase 1 (seed clubs + group leaders), Phase 2 (influencer flywheel), Phase 3 (US expansion)
14. **Team** — Founder background, technical capabilities, golf domain expertise
15. **The Ask** — Funding amount, use of funds (hardware inventory, marketing, US launch, team hires)
16. **Closing** — "Every foursome has one player who shares. That player brings the other three." + contact info

---

## 11. KEY TALKING POINTS FOR THE PRESENTER

- "Nobody edits golf videos twice. The first time takes 3 hours. Clippar does it in 60 seconds."
- "We're not competing with Arccos or Shot Scope. They track stats. We create content. Different job to be done."
- "Golf is the only sport where you play in small groups, have time between shots to check your phone, share everything in a group chat, and the content practically edits itself because each shot is a discrete event."
- "The hardware kit isn't just revenue — it's a retention anchor. Once the mount is on the buggy, churn drops because the product is physically part of their golf setup."
- "Our viral loop doesn't need incentives. Golfers already share. We just make what they share 10x better."
- "The free tier proves the AI works. The paywall is on the reel — the thing they actually want to share. That's high-intent conversion."

---

## 12. DESIGN DIRECTION FOR THE DECK

- **Colour palette**: Dark green (#1a3a2a) + lime green (#a3e635, from the Clippar logo) + white — premium golf aesthetics
- **Typography**: Clean sans-serif (e.g. Inter, SF Pro) for body, display serif for headlines
- **Imagery**: Use the real Clippar assets catalogued in Section 13 below. Real product screenshots, real on-course photography, real AI detection overlays.
- **Tone**: Confident but casual. This is a consumer product for social golfers, not enterprise SaaS. Think "your mate built something sick for golf" not "leveraging AI to disrupt the golf technology vertical."
- **Video embed**: If the platform supports it (e.g. Pitch, Google Slides, Keynote), embed a 30-second real Clippar reel on the Solution slide. A 30-second demo is worth more than 10 slides of explanation.

---

## 13. ASSET INVENTORY — IMAGES & VIDEOS TO USE PER SLIDE

All paths are relative to `/Users/hendacow/projects/final_shipment/`. Every image listed below is a real asset in the project — use them directly.

### LOGOS (use on title slide, footer/watermark, closing slide)

| File | Description | Best Use |
|------|-------------|----------|
| `clippar_logo_square.png` | Lime green "CLIPPAR" + "GOLF VIDEO AI" subtitle on dark background, square format | **Title slide** — main logo, hero placement |
| `clippar_logo_dark_bg.png` | Lime green "CLIPPAR" wordmark on dark background, wide format | Slide headers, footer watermark |
| `clippar_logo_green.png` | Lime green "CLIPPAR" wordmark on white/transparent background | Slides with light backgrounds |
| `clippar_logo_white.png` | White "CLIPPAR" wordmark on transparent background | Over dark photography or video backgrounds |

### HERO / ON-COURSE PHOTOGRAPHY (use on problem, solution, title slides)

| File | Description | Best Use |
|------|-------------|----------|
| `clippar-web/public/landing_assets/hero_clean.jpg` | Golfer mid-backswing on a manicured course, golden-hour light, clubhouse in background. Clean, no overlays. Portrait 9:16. | **Title slide** or **Solution slide** background — the "hero shot" |
| `clippar-web/public/landing_assets/hero_swing2.jpg` | Golfer at address position (about to hit), ball visible on fairway, trees lining right side. Portrait 9:16. | **Problem slide** — "this is how golfers record today" or **How It Works step 2** |
| `static/landing_assets/hero_clean.jpg` | Same as above (duplicate in static dir) | Backup/alternative path |

### AI DETECTION OVERLAYS (use on Tech slide, How It Works)

| File | Description | Best Use |
|------|-------------|----------|
| `clippar-web/public/landing_assets/hero_annotated.jpg` | Split-screen: left = raw golf swing, right = AI debug overlay showing pose skeleton (green lines on body), state machine readout (STATE:SWING), spine angle (34), feet status, swing scores (wrist: 25.7, shoulder: 3.1, hip: 2.7), ball tracking (Gone:12/15f). Shows the full detection pipeline live. | **The Tech slide** — this is the money shot for showing AI capability. Use full-width. |
| `clippar-web/public/landing_assets/hero_annotated2.jpg` | Split-screen: left = putting green scene with two golfers and flag, right = AI debug overlay in IDLE state showing pose skeleton, ball confidence (0.79), span tracking. Demonstrates the state machine in IDLE (waiting for swing). | **The Tech slide** — pair with hero_annotated.jpg to show IDLE vs SWING states |
| `clippar-web/public/landing_assets/steps/step3_poster.jpg` | Split-screen: left = golfer at address with green skeleton overlay drawn on body, right = detection readout (STATE:IDLE, Spine:35.5, Conf:1.00). Shows the pose estimation skeleton on the player. | **How It Works step 3** ("AI detects the swing") or **Tech slide** secondary image |

### HARDWARE KIT PHOTOS (use on Product slide, Business Model slide)

| File | Description | Best Use |
|------|-------------|----------|
| `clippar-web/public/landing_assets/steps/step1_poster.jpg` | Close-up of hands attaching the **phone mount clamp** to a golf buggy handlebar. Shows the actual hardware product — black clamp mechanism being tightened. | **How It Works step 1** ("Mount your phone") or **Business Model slide** (hardware kit visual) |
| `clippar-web/public/landing_assets/steps/step2_poster.jpg` | Phone mounted on buggy via the Clippar mount, golfer swinging in background (slightly blurred). Shows the recording setup from the buggy's perspective — phone is in landscape, capturing the swing. | **How It Works step 2** ("Play your round") or **Solution slide** — shows the product in use on-course |

### APP SCREENSHOTS — COMPETITOR APP (GolfCam reference, use for comparison or inspiration only)

> NOTE: These screenshots (IMG_0679-0692) are from **GolfCam TaylorMade**, a competitor/reference app, NOT from Clippar's own UI. They show a similar workflow which validates the market. Use carefully — for competitor comparison slides or to show "what exists today" on the Problem slide. Do NOT present them as Clippar's UI.

| File | Shows | Potential Use |
|------|-------|---------------|
| `clippar_app/golfcam/IMG_0679.PNG` | GolfCam project setup screen — 3/6/9 holes selector, scorecard grid, orientation/resolution/framerate picker | **Competitor slide** — "existing tools are complex, designed for pros" |
| `clippar_app/golfcam/IMG_0680.PNG` | GolfCam step 1 — course selection prompt | Competitor reference |
| `clippar_app/golfcam/IMG_0681.PNG` | Course search results — Royal Queensland, Bulimba, Nudgee clubs with distance in KM | **Market slide** — shows real AU golf clubs, validates local market |
| `clippar_app/golfcam/IMG_0682.PNG` | Tee selection — Black/Blue/White (Men PAR 72), Red (Ladies PAR 72) with yardages | Competitor reference — tee set selection UI |
| `clippar_app/golfcam/IMG_0683.PNG` | Auto-trimmed clip preview — golfer mid-downswing, "Automatically trimmed" badge, timeline scrubber | **Problem slide** or **comparison** — "competitors can detect, but can't compose a reel" |
| `clippar_app/golfcam/IMG_0684.PNG` | Second auto-trimmed clip — different swing, same UI | Supporting competitor reference |
| `clippar_app/golfcam/IMG_0685.PNG` | Settings screen — resolution, frame rate, camera stabilization toggle, anti-occlusion trace, auto-trim duration selector (4s/6s/9s presets), "2.0s before impact / 2.0s after impact" | **Competitor comparison** — shows existing auto-trim exists but NO reel composition |
| `clippar_app/golfcam/IMG_0686.PNG` | Auto-trimmed clip — golfer at top of backswing, sun flare | Supporting visual |
| `clippar_app/golfcam/IMG_0687.PNG` | Clip import grid — camera roll thumbnails organized as "Hole 1 Stroke 1", shot slots H1 S1-S4 at bottom | **Competitor slide** — shows manual import flow (what Clippar automates) |
| `clippar_app/golfcam/IMG_0688.PNG` | Clip import grid — multiple shots assigned, H1 S2-S4 and H2 slots visible | Supporting competitor reference |
| `clippar_app/golfcam/IMG_0689.PNG` | Video playback with scorecard overlay — live scorecard showing 3 holes (PAR 4,4,4 / yardage 364,314,405 / score 4), play/pause controls | **Solution comparison** — "competitors show a basic overlay, Clippar adds music + auto-edit + sharing" |
| `clippar_app/golfcam/IMG_0690.PNG` | "Project hasn't been saved" dialog — discard/save to draft options | Competitor reference (shows drafts exist in competitor) |
| `clippar_app/golfcam/IMG_0691.PNG` | Export settings — 4K/2K/HD resolution, 30/60 FPS, scorecard editor with holes 10-15 visible (par, yardage, score), intro/outro clip slots | **Competitor comparison** — shows manual scorecard entry, pro-level complexity |
| `clippar_app/golfcam/IMG_0692.PNG` | Drafts list — multiple saved projects, file sizes (13-191MB), courses (Royal Queensland, Ashgrove), dates | Competitor reference |

### DEMO VIDEOS (use for embedded video on Solution/Demo slide)

| File | Description | Best Use |
|------|-------------|----------|
| `clippar-web/public/landing_assets/demo_reel.mp4` | **A complete finished Clippar highlight reel** — this is the hero demo video | **Solution slide** — embed this. Show what the output looks like. |
| `clippar-web/public/landing_assets/demo_clean.mp4` | Raw unprocessed golf swing clip (no overlays) | **Problem slide** — "this is what golfers record today" |
| `clippar-web/public/landing_assets/demo_detected.mp4` | Swing detection visualization — shows the AI identifying a swing | **Tech slide** — shows detection in action |
| `clippar-web/public/landing_assets/demo_swing_detected.mp4` | Swing detected with markers/highlights | **Tech slide** — alternative detection demo |
| `clippar-web/public/landing_assets/demo_annotated.mp4` | Full annotated video with AI debug overlay (pose skeleton, state machine, scores) | **Tech slide** — for technical audience, shows full pipeline |
| `clippar-web/public/landing_assets/demo_vision.mp4` | Vision/pose detection visualization | **Tech slide** — pose estimation demo |
| `clippar-web/public/landing_assets/demo_raw.mp4` | Raw unprocessed input video | Problem/before comparison |
| `clippar-web/public/landing_assets/steps/step1_click.mp4` | Video of mounting the phone/clicking the hardware | **How It Works** step 1 animation |
| `clippar-web/public/landing_assets/steps/step2_swing.mp4` | Video of a golf swing being recorded | **How It Works** step 2 animation |
| `clippar-web/public/landing_assets/steps/step3_clip.mp4` | Video of the AI detecting and trimming | **How It Works** step 3 animation |

### RECOMMENDED SLIDE-BY-SLIDE ASSET MAP

| Slide | Primary Asset | Secondary Asset | Notes |
|-------|--------------|-----------------|-------|
| **1. Title** | `clippar_logo_square.png` | `hero_clean.jpg` as background (darken 60%) | Logo centered, hero image behind |
| **2. The Problem** | `demo_clean.mp4` or `hero_swing2.jpg` | `golfcam/IMG_0683.PNG` (competitor auto-trim) | "Golfers record. Nobody edits. Manual tools exist but are too complex." |
| **3. The Solution** | **`demo_reel.mp4`** (embed) | `clippar_logo_dark_bg.png` in corner | This is the most important slide. Let the reel speak. |
| **4. How It Works** | `step1_poster.jpg` + `step2_poster.jpg` + `step3_poster.jpg` | Or use the .mp4 versions for animation | 3-panel layout: Mount → Play → Share |
| **5. The Tech** | `hero_annotated.jpg` (full width) | `hero_annotated2.jpg` + `step3_poster.jpg` | Split-screen AI overlay is visually striking. Show IDLE vs SWING states. |
| **6. Demo / Screenshots** | Best done as a **live demo** or screen recording of Clippar | `demo_detected.mp4` as backup | If no live demo, use demo_reel.mp4 + 2-3 app screenshots |
| **7. Market** | Stock golf imagery or infographic | `golfcam/IMG_0681.PNG` (course list validates AU market) | Stat-heavy slide, keep imagery minimal |
| **8. Competitors** | `golfcam/IMG_0685.PNG` (competitor settings) | `golfcam/IMG_0691.PNG` (competitor export complexity) | Show competitor complexity vs Clippar simplicity |
| **9. Virality** | Diagram (create new) | `step2_poster.jpg` (phone on buggy = shareable moment) | Group chat loop diagram — create this as a custom graphic |
| **10. Business Model** | `step1_poster.jpg` (hardware kit) | Price cards (create new) | Show the physical product alongside subscription pricing |
| **11. Traction** | Charts (create new) | None | Clean data visualization |
| **12. Financials** | Charts (create new) | None | Revenue ramp table or graph |
| **13. Go-to-Market** | `step2_poster.jpg` (on-course usage) | None | Timeline/roadmap graphic |
| **14. Team** | Headshot(s) | `clippar_logo_dark_bg.png` | Keep minimal |
| **15. The Ask** | None — text-focused | `clippar_logo_square.png` small | Clean, professional |
| **16. Closing** | `hero_clean.jpg` as background | `clippar_logo_white.png` centered | End on the hero image + tagline
