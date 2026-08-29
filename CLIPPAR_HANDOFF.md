# Clippar — Project Handoff & Status

> A self-contained briefing. If you're a new chat/person with zero prior context, read this top to bottom and you'll understand the business, the tech, and exactly where development stands. **As of late June 2026.**

---

## 1. What Clippar is (the business)

**Clippar is a golf app that automatically turns your round into a shareable highlight reel.**

You clip your phone to your golf bag/buggy with a mount, and press a small **Bluetooth clicker** before and after each shot. The app films the whole round, and **AI automatically detects, trims, and assembles every shot** into a short, cinematic highlight reel — no manual editing. Walk off the course with a ready-to-share video of your round.

- **The hook:** "**Strava for golf**." The pull is *highlights* (reliving and sharing your best shots), not stats/improvement. This framing makes people instantly understand it.
- **Detection tech:** vision + audio fusion — pose estimation (YOLOv8), ball tracking, and audio impact detection identify each shot.
- **Hardware:** a phone **mount** + a **Bluetooth clicker** (sold via an in-app Shop).

### Target market & why it works
- **Younger golfers** → virality: they want to share and "prove" their scores. Natural sharing loop.
- **Older golfers (40+)** → high intrinsic value: a hole-in-one or career-best round is worth a lot to someone who's played 30 years and never captured one. Higher willingness to pay.

### Business model
- **Subscription — "Clippar Pro"** via Apple In-App Purchase (RevenueCat). Validated willingness-to-pay ~**$5/round**; far more for milestone rounds.
- **Hardware Shop** (mount + clicker) via **Stripe**.
- **Future — DTC brand partnerships:** Clippar uniquely captures *where, when, and how* people play golf. Vision: members become **micro-influencers** sharing reels to trusted friends — a user-generated growth engine brands can't replicate.

### Traction & validation (so far)
- Founder went to **Germany**, spoke to ~20 people at entrepreneurship/startup events. Key learning: people assumed it was for stats, but the real pull is **highlights**; the "Strava for golf" pitch made everyone get it instantly.
- **Early testers used it on-course** and all said they'd pay ~$5/round.
- **Next steps (founder):** visiting **Munich golf clubs** (head teaching pros — potential club-wide member subscriptions), **App Store launch**, **Facebook ads** (first-time for this app), and pitching **DTC brands**.

### Founder & context
- **Henry** — solo founder, under 25, Australian. Building almost full-time (~80%) alongside school.
- Applying to **Latitude 37** (Airwallex's equity-free accelerator for young Australian AI founders).
- Contact: **clippargolf@gmail.com**

---

## 2. Tech architecture (high level)

| Piece | What | Where |
|---|---|---|
| **Mobile app** | Expo / React Native, iPhone-only | `clippar_app/` — bundle id `com.clippar.app` (`.dev`/`.staging` variants) |
| **Backend** | Supabase (Postgres, Auth, Edge Functions, Storage) | **Prod** `xdefwnqyjffgclzqmvax` · **Dev** `punkaoeuityovwljpyag` (both Sydney) |
| **Video processing** | Heavy AI pipeline (pose/ball/audio) — **separate Python service**, NOT a Supabase function | repo root: `worker.py`, `run_pipeline.py`, `shot_detector.py`, `modal_detector.py` |
| **Marketing site** | Static site → **clippargolf.com** | `clippar-web/` → Vercel (project `clippar`), Git-deploy from `main`, rootDirectory `clippar-web`. DNS on **Cloudflare**. |
| **Payments** | RevenueCat (subscriptions/IAP) + Stripe (hardware Shop) | RevenueCat project "Clippar" (`3078c868`) |
| **Repo** | GitHub `hendacow/Clippar`, production branch `main` | — |

**Key environments:** Supabase **dev** and **prod** are currently **in sync** (same migrations `012`, same edge functions, same secrets).

---

## 3. Development status

### ✅ Done & merged to `main` (App Store compliance + features)
All of these are merged and, where relevant, deployed live:

- **Apple IAP subscriptions** via RevenueCat (#60)
- **Golf course search** — Australian courses ranked first (#61)
- **In-app account deletion** — Apple Guideline 5.1.1(v) (#62)
- **Webhook hardening** — constant-time auth on the RevenueCat webhook (#63)
- **Privacy Policy + Terms of Service** — live at `clippargolf.com/privacy` & `/terms`, footer-linked, content verified accurate (Australia/Sydney data residency, Neon disclosed) (#64, #65, #68)
- **Sign-in-with-Apple + token revocation** — 5.1.1(v) (#66)
- **Native metadata readiness** (#67): iOS permission usage strings cross-checked to real usage, Face ID string added, unused Always-location & background-Bluetooth removed, `ITSAppUsesNonExemptEncryption=false`, privacy manifest, 1024² no-alpha icon verified, EAS-managed versioning. **ATT decision: no tracking → no ATT prompt needed.**

### ✅ Backend deployed to BOTH dev & prod (verified)
- **Migrations:** `010`–`012` applied (both environments at `012`).
- **Edge functions deployed:** `apple-link`, `delete-account`, `revenuecat-webhook`, `create-share-link`.
- **Secrets set (dev + prod):** Apple (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`), `REVENUECAT_WEBHOOK_AUTH`, `REVENUECAT_SECRET_KEY`, `SHARE_BASE_URL`.
- **RevenueCat:** webhook wired to the prod `revenuecat-webhook` URL with auth secret (verified: wrong secret→401, correct→200); v1 secret API key created & set (verified authenticates).

### Paywall
- The paywall UI is **already coded in the app** (`app/paywall.tsx`) — no need for RevenueCat's hosted paywall.
- It currently shows **placeholder/stub pricing** because RevenueCat has no real products yet (see blockers below).

---

## 4. Open items / what's left to launch

### 🔴 Critical path — App Store Connect (founder's tasks; gating)
1. **Create the App Store Connect app record** (confirm bundle id `com.clippar.app`).
2. **Create subscription products** ("Clippar Pro" monthly/annual) — **#1 blocker**: the paywall shows placeholder pricing until these exist.
3. **App Privacy "nutrition label"** — declare data; assert "not used to track."
4. **Fill the real `ascAppId`** in `eas.json` (currently `PLACEHOLDER_PRODUCTION_ASC_APP_ID`).
5. **Demo account + review notes** (reviewers can't golf → point at in-app sample round/tour).
6. **Screenshots** (6.7"/6.9" iPhone), description, keywords, support/marketing URLs.
7. **Age rating** (expect 4+).
8. **Confirm RevenueCat account email** (dashboard shows it unconfirmed).

### ⚙️ Then — finish RevenueCat (do once products exist)
Add the real iOS app to RC, link an App Store Connect API key, import products, create the **"Clippar Pro" Entitlement + an Offering** → paywall shows real prices; purchases flow through the (already-wired) webhook.

### ⚠️ Known gaps discovered in the edge-function audit
- **Reel-viewer web page missing.** `create-share-link` mints links like `clippargolf.com/r/<token>`, but **there's no `/r/[token]` page on the marketing site yet → shared links 404.** Building this page (fetch round by `share_token`, play the reel) completes the viral loop. *Decision pending.*
- **Shop / Stripe not deployed.** The Shop tab (hardware checkout via Stripe) is **live in the app**, but `create-payment-intent` + `stripe-webhook` are **not deployed**. `STRIPE_SECRET_KEY` is on disk. *Decision pending: does the Shop ship in v1? If yes → deploy + confirm live-vs-test key. If no → hide the Shop tab for v1.*
- **`sync-courses` not deployed** — needs `GOLF_COURSE_API_KEY` + a **missing** `GOLF_API_IO_KEY`. Not urgent (course list works from seeded migration `003`).

### ⚠️ Device-only testing (founder)
IAP sandbox purchase, account deletion, Sign-in-with-Apple drop-off, BLE clicker working **without** background mode, Face ID prompt copy. Then **EAS production build → `eas submit`**.

### SEO (marketing site)
Site is SEO-complete (favicon, OG, sitemap, JSON-LD), verified in **Google Search Console**, sitemap submitted. **Not yet indexed** — awaiting Google's crawl after a www→apex canonical fix. Best target keywords: "clippar golf" / "clippargolf".

---

## 5. How development is run (the workflow)

Solo founder + **Claude Code multi-agent orchestration**:
- Several agent "workers" run **in parallel**, each in its own **isolated git worktree/branch**, owning one lane (e.g. IAP, legal, native config) so they can't collide.
- Each opens **CI-gated PRs**; a separate **reviewer agent adversarially checks** every PR before merge (it has already caught real issues, e.g. an unused iOS push entitlement that would've failed App Review).
- A "command-center" session dispatches tasks to the workers (via `tmux`) and reviews/merges their PRs.
- Active Clippar worker terminals: **`golf`** (`clippar-golf-api-search` worktree — web/legal/search) and **`iap`** (`clippar-iap` worktree — IAP/native). *(Note: `supabase`/`teaching`/`teacher-xp` tmux sessions belong to a different project, OPE-GO — not Clippar.)*

---

## 6. One-line summary

**Engineering is essentially done and live** — the app's App-Store-compliance stack and backend are built, deployed to dev+prod, and verified. The remaining work is mostly **App Store Connect data entry + creating the "Clippar Pro" subscription products**, a couple of **deployment decisions** (reel-viewer page, Shop/Stripe), and **on-device testing → submit**.
