# Clippar — App Store Readiness Report
*Generated 2026-06-13 from a full simulator walkthrough (iPhone 17 Pro, iOS 26.5), code review, and current Apple guideline research.*

## TL;DR
The core product loop (import/record → auto-trim → scorecard → preview → reel) **works end-to-end and feels good**. What blocks App Store launch is not polish — it's four hard Apple requirements (subscription IAP, account deletion, privacy disclosures, review demo account) plus one dead monetization button. Realistic path: **P0 list ≈ 1–2 weeks of work**, then TestFlight.

---

## P0 — App Store BLOCKERS (rejection-guaranteed without these)

### 1. Subscription must be StoreKit In-App Purchase
- "Go Pro" in Profile is currently a **no-op** (`onPress={() => Haptics.selectionAsync()}` in `app/(tabs)/profile.tsx`). There is no way to pay for Clippar Pro anywhere in the app.
- Selling the subscription via Stripe on clippargolf.com and linking out **fails App Review 3.1.1 in Australia** (the US external-link carve-out from Epic v. Apple does not apply to the AU storefront).
- **Do:** create a subscription group in App Store Connect (monthly A$19.99 / annual A$149), build a paywall screen, implement with StoreKit 2 (`expo-iap` or RevenueCat — RevenueCat recommended: receipt validation, AU pricing, subscription status syncing to Supabase for free).
- Users who subscribed on the website may still sign in and get Pro (3.1.3(b) multiplatform exception) — but the app must not link or steer to Stripe checkout for it.
- The physical kit in Shop via Stripe is fine (3.1.5 actually *requires* non-IAP for physical goods).
- **Natural paywall touchpoints found in walkthrough:** the Go Pro card, and the Export → "Create Highlight Reel" step (currently has zero gating/limits messaging).

### 2. In-app account deletion (5.1.1(v))
- Not present anywhere in Profile. Must: delete the Supabase user + their data (initiated fully in-app, not a web link), and revoke Sign in with Apple tokens via Apple's REST API.
- Pair it with the existing Sign Out row; confirmation + "this deletes your rounds and reels" copy.

### 3. Privacy disclosures
- **Privacy policy URL** — required in App Store Connect AND accessible in-app (add a Profile row; clippargolf.com/privacy).
- **App Privacy labels** — declare: location (precise, app functionality), user content (videos/photos), identifiers (user ID), diagnostics (Sentry). Sentry-for-crashes is NOT "tracking" → no ATT prompt needed. Ensure @sentry/react-native is current (bundles Apple privacy manifest).
- **Purpose strings** — already good ("Clippar needs camera access to record your golf shots", mic "for shot audio detection"); review location/Bluetooth strings for the same concreteness.

### 4. App Review practicalities
- **Demo account** with Pro unlocked + a seeded round in App Review Information (reviewers won't golf).
- **Hide debug UI in production**: "Trim Sandbox (debug)", "Tracer Sim (debug)" Profile rows must be `__DEV__`-gated.
- "Rate Clippar — Coming soon" → wire `StoreReview.requestReview()` or hide the row.
- Export compliance: set `ios.usesNonExemptEncryption: false` in app.json (HTTPS only).
- Age rating 4+, category Sports (secondary: Photo & Video).

---

## P1 — Bugs found in walkthrough (fix before TestFlight)

1. **Welcome tour fires on the LOGIN screen** — all 5 "Step N of 5" coach-marks render over the email form, anchored to nothing. Gate the tour on auth + Record tab mount.
2. **Sample rounds dead-end at "Round not found"** — every Home card/row for demo data opens an empty detail screen (with share/delete icons). First-session taps all fail. Make sample cards open a CTA ("This is sample data — record your first round") or ship one real demo round.
3. **Go Pro is a silent no-op** (see P0-1) — even before IAP lands, it should at least explain Pro.
4. **Stat tiles clipped under the tab bar** on Home first paint ("0 0 0" digits peeking through).
5. **Sample-data inconsistency** — header says 7 rounds/+6.1 with birdie chips on cards, but Eagles/Birdies/Pars tiles all read 0.
6. **Permission burst** — mic + camera prompts fire back-to-back on opening the Record chooser, before choosing Live vs Import. Ask at first actual use; Import users should see neither.
7. **Photos double-prompt** — limited picker, then immediately a full-library prompt. Use add-only permission for saving reels.
8. **Quick Import dumps all clips on Hole 1** when fewer videos than strokes (3 videos / 12 strokes → 3 clips on hole 1, holes 2-3 empty despite having scores). Distribute in order instead.
9. **Editor title truncation** — "Victoria..." (course names nearly always truncate).

## P2 — UX improvements & feature ideas (make it more fun)

- **First-run home**: hide the course/hole/date filter chips until ≥2 real rounds; replace the dense dashboard with a single "Record your first round" hero for new users.
- **Reel-ready moment**: after export, a full-screen "Your reel is ready 🎉" share card (current flow just ends). This is the viral loop — make it loud, one-tap share to group chat (matches onboarding promise).
- **Highlight discoverability**: "Hold a tile to play a highlight reel" is tiny gray text — make tiles visibly pressable (pulse on first visit).
- **Push notifications** (Henry asked): expo-notifications for (a) "reel finished composing", (b) hardware order shipped, (c) optional weekly "your best shot this week" re-engagement. Needs explicit opt-in (4.5.4 — marketing pushes require consent), a Notifications permission prompt AFTER first reel (not at launch), and the existing Profile > Notifications screen wired to real toggles.
- **Streamline sign-up**: Apple/Google one-tap already there (good); consider making email sign-up secondary ("or use email") — most golfers will tap Apple.
- **Scorecard polish**: the number-pad score entry is genuinely great (auto-advance + color coding). Add a "putts" optional row later for stats depth.
- **Editor**: drag-to-reorder exists; add per-clip "best shot" star that feeds the highlight reel ordering.
- **Tracer**: once field-validated, market it — it's the wow feature. Auto-tag clips that got a tracer with a small 🔥 badge in the editor.

## What already works well (verified end-to-end on sim)
- Email auth against dev Supabase; session persistence; password save sheet.
- Import Round: course search (live API), hole chips, Quick/Manual choice, scorecard entry, photo picker, graceful count-mismatch warning, per-hole review, import → editor.
- Auto-trim batch ran 3/3 on the simulator and produced 4s clips with status badges.
- Preview player: scorecard overlay, progress segments, pose-overlay/mute/trim controls.
- Shop checkout CTA (Stripe physical goods — Apple-compliant as-is).
- Onboarding visuals and copy.

## Suggested launch sequence
1. **Week 1**: RevenueCat + paywall screen (Go Pro + export gate) · account deletion · privacy policy page + in-app links · purpose-string/labels audit · hide debug rows · fix tour-on-login + Round-not-found.
2. **Week 2**: P1 bugs 4-9 · push notifications (reel-ready + order-shipped) · demo account + seeded round · EAS production build → TestFlight with 5-10 golfers.
3. **Submit**: App Store Connect metadata (screenshots from real rounds, Sports category, age 4+, privacy labels, review notes explaining GPS/BLE), `eas submit`.
