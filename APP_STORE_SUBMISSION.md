# Clippar — App Store Connect Submission Package

Everything you paste into App Store Connect, ready to go. Fields marked **[NEEDS YOU]** are decisions or facts only you can supply (or verify). Everything else is drafted — review, tweak to taste, paste.

> Bundle id: `com.clippar.app` · Primary language: English (Australia) · Category: **Sports** (primary), **Photo & Video** (secondary)

---

## ✅ STATUS 2026-07-07 — most of this is DONE in ASC

App record **created**: "Clippar: Golf Highlights", **Apple ID 6788301452**, SKU `clippar-ios-001`. Filled + saved via browser: description, keywords, support/marketing URLs, copyright (© 2026 Henry Coward), subtitle, categories (Sports + Photo & Video), review notes + contact (Henry Coward, clippargolf@gmail.com, +61497608039), Privacy Policy URL, privacy data-types (9 declared, per-type wizards done). Program License Agreement accepted by Henry. `ascAppId` filled in eas.json (PR #82).

**Still open:** age rating questionnaire · Paid Apps Agreement (Henry: banking+tax) · Clippar Pro subscription products + RevenueCat wiring · demo account credentials into review sign-in fields (Henry) · screenshots (Henry, device) · EU trader status (Business section) · production build + `eas submit` · final "Add for Review" click (Henry).

---

## 1. App name & subtitle

**App Name** (max 30 chars) — pick one:
- `Clippar: Golf Highlights` (24) ← recommended, keyword-rich
- `Clippar — Golf Reels` (20)
- `Clippar` (7) — cleanest, but wastes the keyword real estate

**Subtitle** (max 30 chars) — pick one:
- `Auto golf highlight reels` (25) ← recommended
- `Your round, auto-highlighted` (28)
- `Golf reels, made automatic` (26)

---

## 2. Promotional text (max 170 chars — editable anytime without review)

```
Clip your phone to your bag, tap the clicker, and walk off with a cinematic highlight reel of your round. No editing. Just your best golf, ready to share.
```

---

## 3. Description (max 4000 chars)

```
Clippar is the easiest way to relive and share your golf. Clip your phone to your bag or buggy, tap a small Bluetooth clicker before and after each shot, and Clippar films your round and automatically turns it into a short, cinematic highlight reel — no editing required.

Think "Strava for golf," but for your best moments instead of your stats. Walk off the 18th with a ready-to-share video of your round.

HOW IT WORKS
• Mount your phone on your bag or buggy.
• Tap the clicker before and after each shot.
• Clippar's AI detects, trims, and assembles every shot for you.
• Get a polished highlight reel at the end of your round — share it in seconds.

WHY GOLFERS LOVE IT
• Zero editing — the AI does the work, you just play.
• Capture the shots that matter — that career-best round, the hole-in-one you'd never otherwise have on video.
• Share instantly — send your reel to your mates with a single link.
• Built for the course — designed to work while you walk and play.

CLIPPAR PRO
Unlock unlimited highlight reels and premium features with a Clippar Pro subscription. Subscriptions are billed through your Apple ID and renew automatically unless cancelled at least 24 hours before the end of the period. Manage or cancel anytime in your App Store account settings.

Whether you're a younger golfer who wants to share every birdie or a lifelong player who finally wants to capture that round you'll never forget — Clippar makes it effortless.

Privacy Policy: https://clippargolf.com/privacy
Terms of Service: https://clippargolf.com/terms
```

*(Adjust the Pro paragraph once final pricing/features are locked.)*

---

## 4. Keywords (max 100 chars, comma-separated, no spaces)

```
golf,highlight,reel,swing,video,round,shots,clip,montage,scorecard,course,share,birdie,par,editor
```
(96 chars.) Note: don't repeat the app name or "app" — Apple already indexes those.

---

## 5. URLs

| Field | Value |
|---|---|
| Support URL | `https://clippargolf.com` **[NEEDS YOU]** — confirm, or add a `/support` page |
| Marketing URL | `https://clippargolf.com` |
| Privacy Policy URL | `https://clippargolf.com/privacy` ✅ live |

---

## 6. App Privacy ("nutrition label")

**Top-level answer: Data is NOT used to track you** → no ATT prompt (matches the native config decision in #67).

Declare these data types (all **linked to identity**, purpose **App Functionality** unless noted). **[NEEDS YOU to confirm each is accurate for the v1 build]**:

| Data type | Collected? | Purpose | Linked to user? | Tracking? |
|---|---|---|---|---|
| Email address | Yes | App Functionality (account) | Yes | No |
| Name | Yes (via Sign in with Apple, if provided) | App Functionality | Yes | No |
| Photos or Videos (round footage) | Yes | App Functionality | Yes | No |
| User ID | Yes | App Functionality | Yes | No |
| Purchase history | Yes | App Functionality | Yes | No |
| Product interaction (analytics) | Yes | Analytics | Yes (PostHog identifies users) | No |
| **Precise Location** | **Yes — declare it** | App Functionality | Yes | No |
| Crash Data (Sentry) | Yes | App Functionality | No | No |
| Performance Data (Sentry tracing) | Yes | App Functionality | No | No |

✅ **Location resolved (checked the code):** v1 **does** use location — foreground/When-In-Use only — to find your nearby golf course (`components/record/CourseSearch.tsx` via `hooks/useLocation.ts` → `requestForegroundPermissionsAsync`). So **declare Precise Location** (App Functionality, not tracking). The build is already correctly hardened on `main`: it declares `locationWhenInUsePermission` and explicitly deletes the unused "Always" keys (`locationAlwaysAndWhenInUsePermission: false`), so there's no over-declared-permission risk (this was done in #67 — no code change needed).

⚠️ *Minor, optional:* the location usage **string** on `main` still reads "...match each shot to the right hole and measure shot distances on the course" — features that lived in the now-parked tracer. v1's actual location use is just course-finding. Not an App Review blocker, but if the tracer stays parked for v1 you may want to soften the string to "...to find the golf course you're playing." Tied to the tracer decision, so left as-is for now.

Analytics note: PostHog runs through a server-side proxy (`ingest-analytics`), keys are never on-device, and it's product-funnel analytics only — not cross-app tracking, so "Data used to track you = No" holds.

---

## 7. Age rating

Answer **None** to every content question → expected rating **4+**. No objectionable content, no gambling, no unrestricted web, no user-generated content shown to strangers by default (reels are shared by explicit link only).

---

## 8. Review notes + demo (App Review can't play golf)

**Review Notes (paste):**
```
Clippar records a golf round and automatically produces a highlight reel. App Review cannot record a real round, so please use the in-app sample round / demo tour to see the full flow (record → auto-trim → reel → share).

Hardware note: Clippar pairs with an optional Bluetooth "clicker" to mark shots, but the app is fully usable without it — shots can be marked manually, and the sample round demonstrates the output.

Subscription: "Clippar Pro" unlocks unlimited reels. Please test purchases in the sandbox environment.

Demo account:
  Email: [NEEDS YOU]
  Password: [NEEDS YOU]
```

**[NEEDS YOU]** — two things only you can provide:
1. A **demo account** (create it in the app, ideally pre-loaded with one finished sample round so a reviewer sees a real reel). I can't create accounts (rule) and can't log into the app for you.
2. Confirm the **in-app sample round / demo tour** actually exists and is reachable without hardware — if it doesn't, we need one, or the demo account must contain a completed round.

---

## 9. Version info (v1.0)

**What's New / Promotional (first release):**
```
The first release of Clippar. Clip your phone to your bag, tap the clicker, and get an automatic highlight reel of your round.
```
- **Copyright:** `© 2026 [NEEDS YOU — your name or company/entity]`
- **Export compliance:** `ITSAppUsesNonExemptEncryption = false` already baked in (#67) → answer "No" to the encryption question, no extra docs needed.

---

## 10. Screenshots **[NEEDS YOU / device]**

Required: 6.9" (or 6.7") iPhone, 3–10 images. These need a real device/simulator running the app with real content (a finished reel, the record screen, the course picker). I can't capture app screenshots headlessly — this is a you-on-device task. I can help lay them out / add captions once you have the raw frames.

---

## Critical-path order (what unblocks what)

1. **YOU: log into App Store Connect** → I can't (Apple credentials).
2. **YOU: sign the Paid Applications Agreement** (Business → Agreements) incl. banking + tax. Required before any subscription product can exist. I can't enter financial info (rule).
3. Create the **app record** (bundle `com.clippar.app`) — paste §1 name/subtitle.
4. Create **"Clippar Pro"** subscription product(s) → this is the #1 blocker; the paywall shows placeholder prices until it exists.
5. **Then I finish RevenueCat** (you're already logged in): add the real iOS app, link an ASC API key, import the products, build the Pro entitlement + offering. Paywall goes live with real prices.
6. Fill the real `ascAppId` in `eas.json` (I'll do it the moment the app record exists — it's shown on the app's ASC page).
7. Paste §3/§4/§6/§7/§8/§9. Add §10 screenshots.
8. `eas build` (production) → `eas submit`.

---

*Drafted by Claude, 2026-07-02. Update as decisions land.*
