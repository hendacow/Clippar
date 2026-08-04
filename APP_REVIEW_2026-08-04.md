# Clippar — Pre-Submission App Review
**Date:** 2026-08-04
**Reviewed build:** `com.clippar.app.dev` (Clippar Dev), Expo dev client on iPhone 17 simulator (iOS 26.x), Metro `127.0.0.1:8083`
**Guidelines source:** [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), fetched 2026-08-04. Every quote below is verbatim from that page.
**Screenshots:** `/Users/hendacow/projects/clippar-codes/review-shots/`

### How this review was done
Signed in with a throwaway Supabase account (`email_confirm: true` via admin API), walked onboarding → auth → home → record → import → scorecard → editor → preview → export → paywall → redeem → orders → shop → every Profile row → account deletion. The throwaway account was deleted through the app's own Delete Account flow and **verified purged server-side** (auth user 404; `rounds`/`profiles`/`shots` all 0 rows).

### Two caveats on accuracy
1. **Another agent was editing source concurrently.** The running JS bundle was in places older than disk (e.g. the bundle showed "Verify My Rounds" while disk already said "Verify My Rounds (debug)" behind a `__DEV__` gate). **Every finding below was re-verified against on-disk source at the end of the review** and still reproduces there. Line numbers are from that final check.
2. Findings marked **[static]** were derived from source only and not reproduced on device — they are called out explicitly rather than presented as observed.

---

## Blockers — these get the app rejected

### B1. Terms of Use and Privacy Policy both display a "DRAFT — not yet legally reviewed" banner
**Severity:** Blocker
**Guideline 2.1(a):** *"Submissions to App Review … should be final versions with all necessary metadata and fully functional URLs included; placeholder text, empty websites, and other temporary content should be scrubbed before submission."*
**Guideline 5.1.1(i):** *"All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app in an easily accessible manner."*

**Where:** `https://clippargolf.com/terms` and `https://clippargolf.com/privacy`, linked from `app/paywall.tsx:360,363`, `app/(tabs)/profile.tsx:930-937`, `app/(auth)/signup.tsx:281-291`.

**Evidence:** `review-shots/01-terms-draft-banner.png`. I tapped **Terms** on the paywall and landed on a page headed:
> "⚠ Draft — not yet legally reviewed … It has not been reviewed or approved by a lawyer and must be checked against applicable consumer and contract law … Do not rely on it as a final, legally vetted agreement."

`curl` confirms the same banner on `/privacy`: *"…has not been reviewed or approved by a lawyer. Before launch it must be checked against the laws referenced below (the Australian Privacy Act, GDPR, CCPA/CPRA, COPPA)…"*

This is the single highest-risk item: it sits one tap from the paywall, on the two documents 3.1.2 and 5.1.1 require, and it explicitly tells the reviewer the app is not launch-ready.

**Fix:** Remove the `<div class="draft">` block from both pages in `clippar-web` (the CSS class is `draft`; the markup is a sibling of the page header). Do not ship until the copy is final.

---

### B2. "Rate Clippar" ships a "Coming soon" dialog
**Severity:** Blocker
**Guideline 2.1(a):** *"placeholder text … and other temporary content should be scrubbed before submission."*

**Where:** `app/(tabs)/profile.tsx:937-945`. Not `__DEV__`-gated — confirmed on disk at final check.

**Evidence:** `review-shots/03-rate-clippar-coming-soon.png`. Row reads "Rate Clippar / Coming soon"; tapping shows `Alert.alert('Coming Soon', "We'll wire this up when we're live on the App Store.")`.

**Fix:** Delete the `SettingsRow` at `profile.tsx:937-945` (and its preceding `<Divider />` at `:936`) for v1. If you want it, replace `onPress` with `expo-store-review`'s `StoreReview.requestReview()` guarded by `await StoreReview.isAvailableAsync()`.

---

### B3. Edit Profile is unusable — no header, no Save, avatar clipped by the Dynamic Island
**Severity:** Blocker
**Guideline 2.1(a):** *"We will reject incomplete app bundles and binaries that crash or exhibit obvious technical problems."*
**Guideline 4 (Design):** *"Apple customers place a high value on products that are simple, refined, innovative, and easy to use… the following are minimum standards for approval."*

**Where:** `app/profile/edit.tsx:162` vs `:173-196`.

**Root cause (precise):** The loading branch renders `<Stack.Screen options={{ headerShown: false }} />` at `:162`. When loading finishes, the loaded branch renders a *second* `<Stack.Screen>` at `:173-196` that sets `title: 'Edit Profile'`, a `headerLeft` (X / close) and a `headerRight` (✓ / save) — but **never sets `headerShown` back to `true`**. React Navigation merges options, so `headerShown:false` from the loading state persists. The header, and with it the only Save control, never appears.

**Evidence:** `review-shots/07-edit-profile-clipped-avatar-no-header.png`. Observed: no title, no back/close, no save. The avatar circle and its green camera button are pushed to y≈0 and collide with the Dynamic Island (this is the overlap Henry found — the cause is the missing header, not the avatar's own layout). The screen does not scroll. The interactive left-edge pop gesture still works, so the user is not trapped, but **profile edits can never be saved**.

**Fix:** In `app/profile/edit.tsx:174`, add `headerShown: true,` as the first key of the loaded-state `options` object. That single line restores the title, the X, the ✓ Save, and pushes content below the safe area, resolving the avatar/Dynamic Island collision at the same time.

---

### B4. In-app purchase cannot be exercised — no RevenueCat key in any checked-in config
**Severity:** Blocker (if the EAS cloud env is also missing it)
**Guideline 2.1(b):** *"If you offer in-app purchases in your app, make sure they are complete, up-to-date, visible to the reviewer and functional."*
**Guideline 3.1.1:** *"…you should make sure you have a restore mechanism for any restorable in-app purchases."*

**Where:** `constants/config.ts:60-63` reads `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_REVENUECAT_IOS_KEY`. **Neither appears in `.env.local`, `.env.development.local`, or `eas.json`** (grep count 0 in all three). With no key, `lib/iap.ts` falls through to `StubProvider`.

**Evidence:** On the paywall I tapped **Subscribe** and got an alert stating purchases are not available in this build. **Restore Purchases** returned "Nothing to restore" — `StubProvider.restore()` is `return false` (`lib/iap.ts:101-103`).

**Fix:** Confirm `EXPO_PUBLIC_RC_IOS_KEY` is set in the EAS production environment before building the submission binary, then verify on TestFlight that Subscribe reaches the StoreKit sheet and Restore returns a real result. If the key is already in EAS cloud env this is a non-issue — but it is not verifiable from the repo, so treat it as blocking until confirmed.

---

### B5. The disabled Shop is reachable in two taps, and its checkout is broken
**Severity:** Blocker
**Guideline 2.1(a):** *"We will reject incomplete app bundles and binaries that crash or exhibit obvious technical problems."*

**Where:** `app/profile/orders.tsx:49` → `router.push('/(tabs)/shop')`. `app/(tabs)/_layout.tsx:26` sets `SHOP_ENABLED = false` and `:247` uses `href: SHOP_ENABLED ? undefined : null`.

**The bug:** the comment at `_layout.tsx:243` claims *"href: null removes Shop from the navigator when disabled"*. That is false — `href: null` only removes the **tab item**; the route stays registered and `router.push` reaches it normally.

**Evidence:** Profile → Orders → empty state → **"Shop Clippar Kit"** opened the full Clippar Kit store (`review-shots/05-shop-reachable-via-orders.png`). I tapped **Buy Now — $59 AUD** and got `Payment Failed — Edge Function returned a non-2xx status code` (`review-shots/06-shop-payment-failed-raw-error.png`). No purchase occurred. The `create-payment-intent` function is not deployed (per the comment at `_layout.tsx:21-25`).

Three problems in one screen: a feature the team believes is hidden is reachable; its checkout is non-functional; and the failure surfaces a raw SDK error string to the user.

**Fix:** In `app/profile/orders.tsx:47-50`, wrap the "Shop Clippar Kit" `<Button>` in `{SHOP_ENABLED && ( … )}` (export `SHOP_ENABLED` from `app/(tabs)/_layout.tsx:26`, or move it to `constants/config.ts`). When it is hidden, the empty state should read "No orders yet" with no CTA. Separately, in `app/(tabs)/shop.tsx:116`, replace the raw error with a fixed user-facing string — never interpolate the SDK message.

---

## Major — bad first impression, likely reviewer note

### M1. A push-notification settings screen for push that is never registered
**Severity:** Major
**Guideline 2.3.1:** *"Don't include any hidden, dormant, or undocumented features in your app; your app's functionality should be clear to end users and App Review."*

**Where:** `app/profile/notifications.tsx`, linked ungated from `app/(tabs)/profile.tsx:870`.

**Evidence:** `review-shots/08-notifications-dead-toggles.png` — a "PUSH NOTIFICATIONS" card with three toggles (Reel Ready, Shipping Updates, News & Tips), two defaulted ON. No permission prompt ever appeared during the entire review. `registerForPushNotifications()` (`lib/notifications.ts:16`) has **zero call sites** across `app/`, `components/`, `hooks/`, `lib/`, `contexts/` — grep returns only its own definition and its own error log. `expo-notifications` is deliberately excluded from `plugins` (`app.config.js:209-215`), so the build gets no `aps-environment` entitlement. The toggles only write to AsyncStorage (`notifications.tsx:70-73`).

Also note "Shipping Updates" refers to the hardware shop, which is disabled (B5).

**Fix:** Remove the row at `profile.tsx:868-871` for v1 and leave `app/profile/notifications.tsx` unrouted, or implement registration. Do not ship toggles that promise notifications the app cannot send.

---

### M2. "Discard Round" does not discard the round
**Severity:** Major
**Guideline 2.1(a):** obvious technical problems.

**Where:** `app/(tabs)/record.tsx:1500-1508` → `useRound.discardRound` → `hooks/useRound.ts:678-686`.

**Evidence:** I started a live round at "Pebble Creek Club" (18 holes), ended it, tapped **Discard Round**, and confirmed **Discard** on a dialog that said *"Are you sure? This cannot be undone."* After the app restarted, the round was still listed under "Your rounds" as "Pebble Creek Club — Today · 18 holes · 0 clips". Deleting it properly from Round detail → ⋮ → Delete round did remove it.

`discardRound` calls `deleteLocalRound(roundId)` inside a `try` whose `catch` only `console.error`s (`useRound.ts:683-685`), so any failure is silent and the user is told the round is gone when it is not.

**Fix:** In `hooks/useRound.ts:678-686`, surface failure instead of swallowing it, and confirm the delete actually committed before clearing state. Reuse the same delete path the round-detail screen uses, which works.

---

### M3. The paywall sells features that are not gated
**Severity:** Major
**Guideline 3.1.2(a):** *"If you offer an auto-renewable subscription, you must provide ongoing value to the customer…"*
**Guideline 2.3.1:** *"…marketing your app in a misleading way, such as by promoting content or services that it does not actually offer … is grounds for removal."*

**Where:** `constants/config.ts:53` — `enforceExportGate: false`. Its only consumer is `app/round/editor.tsx:925`.

**Evidence:** The paywall advertises "Unlimited highlight reels", "Unlimited exports & shares", "Shot tracer on every full swing", "All detection & trim settings" (`paywall.tsx:32-37`). With the gate off, I reached Export and tapped **Create Highlight Reel** on a free account with no paywall interruption. Nothing in the app is currently behind Pro.

**Fix:** Either set `enforceExportGate: true` before submission so the advertised benefit is real, or reword the paywall bullets to describe only what Pro actually changes. A reviewer who buys nothing and still gets everything may read the paywall as misleading.

---

### M4. "Redeem a code" unlocks Pro for life outside of in-app purchase
**Severity:** Major (Blocker risk)
**Guideline 3.1.1:** *"Apps may not use their own mechanisms to unlock content or functionality, such as license keys, augmented reality markers, QR codes, cryptocurrencies and cryptocurrency wallets, etc."*

**Where:** `app/profile/redeem.tsx`, linked from `app/(tabs)/profile.tsx:884-889` and `app/paywall.tsx:377-391`. Backend: `supabase/functions/redeem-code`.

**Evidence:** The screen accepts a `CLIP-XXXX-XXXX-XXXX-XXXX` code and states it turns it into "Pro for life". I entered a dummy code; it auto-formatted correctly and failed with the graceful message "Something went wrong" — the known undeployed migration. The screen carries the disclaimer "Codes are issued by Clippar and are not for sale."

The guideline's prohibition on developer-run unlock mechanisms is not conditioned on whether the code was sold. The compliant path is Apple's own **Offer Codes** redeemed via StoreKit's `presentCodeRedemptionSheet()`, which Apple supports precisely for ambassador/comp scenarios.

**Fix:** For v1, the safest move is to remove the "Redeem a code" entry points (`profile.tsx:884-889`, `paywall.tsx:377-391`) and grant ambassadors App Store **Offer Codes** instead. If you keep it, expect to justify it in Review Notes; be aware this is a common rejection trigger.

---

### M5. `handleRestore` has no `catch` — restore failures are silent
**Severity:** Major
**Guideline 3.1.1:** *"…you should make sure you have a restore mechanism for any restorable in-app purchases."*

**Where:** `app/paywall.tsx:121-137` — `try { … } finally { … }` with no `catch`. Confirmed on disk at final check.

**Evidence:** Source-verified. `handlePurchase` (`paywall.tsx:98`) catches correctly; `handleRestore` does not. A rejecting `restorePurchases()` (network drop, StoreKit error) produces an unhandled rejection: the spinner stops and no alert appears, so the button reads as dead. A reviewer testing restore on a flaky network sees a non-functional control.

**Fix:** Add `catch (e) { Alert.alert('Restore failed', 'We could not reach the App Store. Check your connection and try again.'); }` between the `try` block and `finally` at `paywall.tsx:136`.

---

### M6. Fallback prices contradict the documented App Store Connect prices
**Severity:** Major
**Guideline 2.3.1:** *"…promoting a false price, whether within or outside of the App Store, is grounds for removal."*

**Where:** `constants/config.ts:48-49` — `monthlyPriceAud: 1499`, `annualPriceAud: 9999`, rendered by `lib/iap.ts:78-93` as **A$14.99/month** and **A$99.99/year**. `IAP_SETUP.md:48-51` documents the ASC products as **A$19.99/month** and **A$149.00/year**.

**Evidence:** The paywall displayed A$14.99 and A$99.99 with a "Save 44%" badge — these are the stub fallbacks, shown because no RevenueCat key is configured (B4). When StoreKit is live the real `priceString` is used (`lib/iap.ts:278`), so this only misprices when the app falls back. But B4 means the fallback is exactly what a reviewer would see today.

**Fix:** Align `constants/config.ts:48-49` with the real ASC prices so the fallback can never understate the charge. Fixing B4 removes the exposure entirely.

---

### M7. Dev-only routes remain in the production bundle **[static]**
**Severity:** Major
**Guideline 2.3.1:** *"Don't include any hidden, dormant, or undocumented features in your app."*

**Where:** `app/(dev)/detection-ab.tsx`, `app/(dev)/tracer-sim.tsx`, `app/profile/trim-sandbox.tsx`, `app/profile/diagnostics.tsx`.

**Reasoning:** The `__DEV__` guards at `app/(tabs)/profile.tsx:719` (trim-sandbox, tracer-sim), `:869` (diagnostics) and `:983` (verify-rounds) hide the **navigation links**, and I confirmed those gates exist on disk. But Expo Router registers every file under `app/` into the route tree at bundle time; `metro.config.js:55-70` `blockList` does not exclude `app/(dev)/`, and `.easignore` does not either. The only route-level guard, `app/_layout.tsx:108` (`__DEV__ && segments[0] === '(dev)'`), is consumed solely inside the `if (!user)` branch — it redirects signed-out users and does nothing for a signed-in one, and never covers `/profile/*`.

**Not device-verified** — I could not test release-build deep links from a dev-variant binary. Worth a 30-second check on the TestFlight build: `clippar:///profile/diagnostics`.

**Fix:** Move these four files outside `app/` (e.g. `devscreens/`) so they are never registered as routes, or add a release-only metro `blockList` entry. Relying on `__DEV__` around links alone leaves the routes live.

---

## Minor — polish

- **P1. Shop price digits collide with the selection circles.** On `app/(tabs)/shop.tsx`, the "$59"/"$69" labels are overlapped by the radio/check indicators, clipping the final digit. See `review-shots/05-shop-reachable-via-orders.png`. Moot if B5 is fixed by hiding the entry point, but fix before the Shop ships.
- **P2. Preview chrome clips the scorecard overlay.** In the reel preview, the bottom "Hole 1 · Par 4 · Shot 3 of 3 · Par" bar overlays the burned-in scorecard's par row, cutting the digits mid-glyph. `review-shots/09-preview-scorecard-overlap.png`. Affects in-app preview only, not the exported video.
- **P3. Course search returns duplicate rows.** Searching "Royal Melbourne" returned three byte-identical "Royal Melbourne Gc / Melbourne, VIC" entries. Dedupe results by name+location before rendering (`components/record/CourseSearch.tsx`).
- **P4. Internal vendor name in user-facing copy.** `app/(tabs)/profile.tsx:528` — `Alert.alert('Verify Rounds', 'No rounds found in Supabase.')`. `review-shots/04-verify-rounds-supabase-leak.png`. Now behind `__DEV__` on disk, so release-safe; reword if it is ever un-gated.
- **P5. Record shutter is off-centre.** In live recording the shutter's centre sits at x≈176pt against a screen centre of 201pt — visibly left of centre, because the right-hand control group (Prev / Next Hole) is wider than the left (Penalty). Give the three groups equal flex, or absolutely centre the shutter.
- **P6. Reset-code placeholder is clipped.** On `app/(auth)/reset-password.tsx` the placeholder "Paste the code from you…" overflows the field and is cut mid-word. Shorten the string.
- **P7. Orders cannot distinguish "no orders" from "fetch failed."** `lib/api.ts:666-673` swallows the error and returns `[]`; `orders.tsx:24` catches to `setOrders([])`. A user whose fetch fails sees "No orders yet". Add an error state.
- **P8. Two purpose strings under-declare their use** (5.1.1(ii): *"Ensure your purpose strings clearly and completely describe your use of the data."*):
  - `app.config.js:232` — mic is described as "for shot audio detection", but the recorded audio track is uploaded (your own privacy-manifest comment at `app.config.js:90-91` says so). Reword to cover recording **and** upload.
  - `app.config.js:253` — `NSPhotoLibraryUsageDescription` reads "Clippar saves your highlight reels to your photo library" (a write-only justification), but full read/write is requested at `app/round/import.tsx:668`, `app/round/editor.tsx:1301`, `lib/sharing.ts:61`, `lib/clipShare.ts:44`, and `lib/photosRecovery.ts:40` genuinely reads the library. Either pass `writeOnly: true` on the save-only paths or reword to cover reading.
- **P9. Signup legal line sits under the home indicator at rest.** "By creating an account you agree to our Terms of Service and Privacy Policy" is cut off until you scroll. It is reachable, so not a blocker — add bottom padding.

---

## What I verified as working

- **Onboarding** — all 9 steps, progress bar, back navigation, course search (live API, real results), handicap/age pickers, sample-reel escape hatch for users with no golf clips.
- **Photo picker** uses `PHPicker`, so no photo permission prompt is needed for import — good practice and one fewer permission for a reviewer to question.
- **Auth** — sign-up screen, sign-in, sign-out, Forgot Password (sends without leaking whether an account exists — correct anti-enumeration). Sign in with Apple and Google are both present, satisfying 4.8 alongside Google.
- **Import flow, end to end** — course required (validation fires), hole count, Quick vs Manual, scorecard with auto-advancing number pad and live total, video selection, and a clear amber warning when clip count ≠ stroke count. Round saved correctly.
- **Editor** — clips imported and auto-trimmed (0:06 → 0:04 confirmed), per-hole grouping, Intro/Outro slots, background-music slot, per-clip delete/download.
- **Preview player** — plays, segment progress bar, scorecard overlay renders with correct scores.
- **Paywall structurally satisfies 3.1.2** — price, billing period, four benefit bullets, and the full auto-renew disclosure (*"Payment is charged to your Apple ID at confirmation of purchase. The subscription automatically renews unless auto-renew is turned off at least 24 hours before the end of the current period…"*), plus **Restore Purchases**, **Terms** and **Privacy** all present on the paywall itself. Terms/Privacy `Linking.openURL` calls are live, not dead (I followed Terms into Safari).
- **"Dev: unlock Pro"** is genuinely safe: `lib/devPro.ts:isDevVariant()` requires **both** `extra.variant === 'development'` **and** a bundle id ending `.dev`. It is structurally impossible in an App Store binary — no action needed.
- **`[DEV] Simulate Shutter Press`** is `__DEV__`-gated at `app/(tabs)/record.tsx:1421`.
- **Account deletion (5.1.1(v)) — fully compliant and better than most.** Reachable from Profile with no subscription, two-step confirmation with honest copy ("Copies you saved to your Photos library stay"), password re-authentication, then a genuine hard delete. **Verified server-side:** auth user returns 404 and `rounds`, `profiles`, `shots` are all 0 rows. The edge function also revokes Sign-in-with-Apple tokens against Apple's `/auth/revoke` — the part most apps miss.
- **Storage & Backup** — exemplary. "What happens if I uninstall Clippar?" states plainly which data survives and which is lost. Exactly the transparency 5.1.1 wants.
- **Round detail delete** — works, and its copy honestly says "on this phone".
- **Recording failure handling** — the simulator's camera failure produced a friendly "Recording failed… check your free storage" dialog rather than a crash.
- **Crash recovery** — after the export crash the app relaunched with the round and all 3 clips intact.
- **Permissions** — every runtime permission request has a matching purpose string; no crash-on-request. Location is correctly When-In-Use only (the Always keys are explicitly deleted at `app.config.js:246-247`). No ATT/tracking, contacts, calendar, or HealthKit usage; `NSPrivacyTracking: false` is consistent.
- **No external purchase links.** Full `Linking.openURL` inventory checked: no Stripe/checkout/"buy on web" URL is reachable from the app. Stripe is used only as a native in-app PaymentSheet for **physical** goods, which 3.1.3(e) permits. Clean on 3.1.1 in that respect.

---

## What I could not test, and why

| Area | Why | Who it affects |
|---|---|---|
| **Video export / reel composition** | Hard crash to SpringBoard. Crash report `ClipparDev-2026-08-04-132854.ips` shows `EXC_BREAKPOINT` in `libxpc _xpc_api_misuse` → `xpc_shmem_create_with_prot` → `IOSurfaceCreate` → `QuartzCore CA::OGL::render_layers` — the **simulator's software GLES path failing to allocate a GPU surface**, not the app's AVFoundation code. Simulator limitation, as expected. | Not the reviewer (real device) |
| **Live camera capture** | Expo LogBox confirmed `"Calling the 'record' function has failed → Caused by: This operation is not supported on the simulator"`. | Not the reviewer |
| **BLE shot clicker** | No Bluetooth hardware on simulator. A reviewer without the clicker will see the red "No Clicker Connected / Disconnected" state — see note below. | **Yes** |
| **Sign in with Apple / Google** | Both buttons render; completing either needs a real Apple ID / Google account, which I will not use on Henry's behalf. | **Yes — test on TestFlight** |
| **Redeem a code, success path** | `redeem-code` migration not deployed; every code returns "Something went wrong". Failure handling verified as graceful. | **Yes** |
| **Live App Store prices** | No RevenueCat key configured (B4), so only stub prices were observable. | **Yes** |
| **Push notifications** | Not registered at all (M1); nothing to test. | **Yes** |
| **Hardware order tracking** | Requires a real `hardware_orders` row. | No |
| **Release-build deep links to dev routes (M7)** | Dev-variant binary only. | **Yes — 30s check on TestFlight** |

### One extra note for the reviewer experience
On the live-recording setup screen the first thing a reviewer sees is a red **"No Clicker Connected / Disconnected"** badge. The app works fine without the clicker (onboarding even offers "Film by hand"), but a red error state on the primary capture screen reads as broken hardware on first launch. Consider softening it to a neutral "Clicker optional — tap to pair" when no clicker has ever been paired. This is a first-impression item, not a guideline violation.

---

## Suggested order of work

1. **B1** — strip the draft banners from `/terms` and `/privacy` (highest risk, smallest change, lives in `clippar-web`).
2. **B3** — one line: `headerShown: true` in `app/profile/edit.tsx:174`.
3. **B2** — delete the "Rate Clippar" row.
4. **B5** — gate the "Shop Clippar Kit" button on `SHOP_ENABLED`; stop interpolating raw SDK errors.
5. **B4** — confirm `EXPO_PUBLIC_RC_IOS_KEY` in the EAS production env, then verify purchase + restore on TestFlight.
6. **M1** — remove the notifications row.
7. **M3 / M4** — decide the Pro-gating and redeem-code stories before submitting; both are judgement calls that need Henry's input, not just a code change.
8. **M2, M5, M6** — small, self-contained code fixes.
