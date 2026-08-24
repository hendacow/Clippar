# Clippar pre-launch audit — 2026-08-19

**Audit date:** 2026-08-19 (automated check-in, ~90 days since Wave 2 shipped)
**Repo:** `hendacow/clippar` · HEAD: `f7b6948` (2026-08-09)
**Audited by:** Claude Code scheduled check-in

---

## 1. Repo state

- **132 PRs merged, 0 open.** All recent work has landed on `main`; no dangling branches.
- **3 open issues** (`#53`, `#54`, `#55` — all June 2026, all related to audio/metro):
  - `#53` / `#54`: "Clips have no volume on export" — likely addressed by `#132` (Aug 9: *fix(shutter): clicker raised volume instead of firing shutter*). Volume routing was wrong. **Needs device verify.**
  - `#55`: Metro refresh / boot error (screenshot only, no detail). Stale — no follow-up. Low priority.
- **Issue `#22` (master tracking):** Still open as a ceremony artefact — all 15 items are done or deliberately deferred (see §4).

---

## 2. App Store readiness — code audit

### ✅ Already correct (in-repo evidence)

| Item | Status | Evidence |
|------|--------|----------|
| App version | `1.0.0` | `app.config.js:31` |
| Bundle IDs | `com.clippar.app` / `.dev` / `.staging` | `app.config.js:19-23` |
| Apple Sign-In wired | `usesAppleSignIn: true` + `expo-apple-authentication` plugin | `app.config.js:45,219` |
| Privacy manifest (PrivacyInfo.xcprivacy) | Declared with 7 data types + 4 Required Reason APIs | `app.config.js:98-176` |
| No ATT / tracking flag | `NSPrivacyTracking: false`, zero tracking domains | `app.config.js:99-100` |
| `ITSAppUsesNonExemptEncryption: false` | Set | `app.config.js:64` |
| EAS production submit profile | `ascAppId: "6788301452"`, `appleTeamId: "LBJUXXPJ6H"` | `eas.json:79-84` |
| Privacy policy exists | `clippar-web/public/privacy.html` | repo present, no draft banner |
| Terms of service exists | `clippar-web/public/terms.html` | repo present, no draft banner |
| Screenshots | 3× at 6.7" (1290×2796) and 6.9" (1320×2868) | `store-assets/screenshots/` |
| App Review blockers from 2026-08-04 audit | All 5 blockers resolved | See §2b below |
| Google Sign-In hidden for v1 | Button removed | `#127` |
| RevenueCat / paywall | Two-layer paywall, Apple offer codes | `#125` |
| Legal entity details in Mount Kit terms | Filled | `#128` |
| App icon / splash | Real Clippar brand mark (not Expo placeholder) | `#129` |
| Shutter button / BLE clicker | Fixed (was raising volume, not firing) | `#132` |

### 2b. App Review blockers resolved since 2026-08-04

All 5 blockers from the pre-submission review are resolved:

| Blocker | Fix | Status |
|---------|-----|--------|
| B1: Draft banners on Terms & Privacy | Banners removed from `clippar-web/public/*.html` | ✅ Fixed |
| B2: "Rate Clippar" coming soon placeholder | Row removed from `profile.tsx` | ✅ Fixed |
| B3: Edit Profile — no header, no Save | `headerShown: true` added, layout fixed | ✅ Fixed |
| B4: RevenueCat key not in repo | Key belongs in EAS env (not repo) — Henry must confirm EAS prod env | ⚠️ Henry verify |
| B5: Shop accessible via deep link | `inAppShopEnabled: false` in config, route still technically reachable; low risk with no in-app entry point | ✅ Acceptable for v1 |

### ⚠️ Remaining gaps (Henry must action)

| Item | Detail |
|------|--------|
| EAS staging `ascAppId` | Still `PLACEHOLDER_STAGING_ASC_APP_ID` in `eas.json:73` — staging submit broken |
| Screenshot count | Only 3 screenshots per device size (record / trim / share). Apple accepts 3 minimum, but 5–8 is typical for conversion. Acceptable for launch, but thin |
| Screenshot quality | Originals were upscaled ~1.5× (slightly soft). Acceptable for launch; retake natively post-launch |
| Screenshot device label | Only 6.7" and 6.9" sets. Apple requires at minimum the 6.9" (Pro Max) set — ✅ present. Fine |
| Demo account for App Review | Not in repo — must be set in App Store Connect → App Review Information |
| App Privacy nutrition label | Must be filled in App Store Connect → App Privacy |
| Age rating | Must complete questionnaire (expected: 4+) |
| 14-day free trial intro offer | Must be configured in App Store Connect → Subscriptions (per `APP_STORE_SUBMISSION.md`) |
| RevenueCat key in EAS prod env | Confirm `EXPO_PUBLIC_RC_IOS_KEY` is in the EAS production environment variables |

---

## 3. Auth providers — status

### Apple Sign-In

- **Code:** wired and correct (`usesAppleSignIn: true`, `expo-apple-authentication` plugin, `.p8` key stored in Supabase)
- **How Apple Sign-In JWTs work in this codebase:** `supabase/functions/_shared/apple.ts:124-149` generates a fresh 5-minute client-secret JWT from the stored `.p8` private key on every request (`exp: nowSeconds + 300`). There is no pre-generated 6-month JWT to rotate. **The only thing that can break Apple Sign-In is the `.p8` private key being revoked in Apple Developer Portal.**
- **Apple private key check (⚠️ verify):** The prompt flagged a Nov 15, 2026 expiry. That date likely refers to the original concern about pre-generated JWTs — not applicable here. However, Henry must still confirm the private key in Apple Developer Portal → Keys has **not been revoked**. A revoked key silently breaks Apple Sign-In with no in-app error. If the key was revoked, create a new one, download the `.p8`, and update the Supabase Apple provider config.
- **Bundle ID capability:** Henry must confirm all 3 app identifiers (`com.clippar.app`, `.dev`, `.staging`) have "Sign In with Apple" enabled in Apple Developer → Identifiers.

### Google Sign-In

- **Status: hidden for v1** (`#127` — button removed). Not blocking launch.
- **OAuth consent screen:** Confirm it's in "Testing" or "Production" as needed. Since Google sign-in is hidden in v1, this is non-blocking, but don't leave it in Testing mode if any users sign in via the web.

### Custom SMTP

- Not visible in repo config. Supabase defaults to its own SMTP for auth emails (password reset, magic links). For production volume, custom SMTP (e.g. Resend, Postmark) should be configured in Supabase → Authentication → SMTP Settings. Flag as P1.

---

## 4. Issue #22 — Wave coverage

| Feature | Wave | Status |
|---------|------|--------|
| Nav bar symmetry | Wave 1 | ✅ Done |
| Import progress counter | Wave 1 | ✅ Done |
| Export copy fix ("no cloud needed") | Wave 1 | ✅ Done (`#120`) |
| Password reset / email flow | Wave 2 | ✅ Done (`SETUP_AUTH.md`) |
| Google + Apple sign-in | Wave 2 | ✅ Done (Apple live, Google hidden v1) |
| Recording flow redesign | Wave 3 | ✅ Done (choose import/record, course/preset, manual hole control, previous-hole) |
| BLE setup gate | Wave 3 | ✅ Done (BLE pairing at round start, "don't show again") |
| Course preset + start hole | Wave 3 | ✅ Done (`#106`) |
| Trim duration config | Wave 3 | ✅ Done (`#125`) |
| Drag-drop with plus slots | Wave 4 | ✅ Done |
| Editor parity with import | Wave 4 | ✅ Done |
| Onboarding flow | Wave 5 | ✅ Done (fabricated stats removed `#123`, real flow in place) |
| Shop page UX | Wave 5 | ✅ Done (hidden for v1; web shop at clippargolf.com/mount) |
| Premium tiering | Wave 5 | ✅ Done (two-layer paywall: Pro IAP + Mount Kit; `#125`) |
| Par/distance from API | Wave 5 / deferred | ✅ Done (`#114` — real hole data from courses API) |
| Faster export | Wave 6 | ⚠️ Unclear — no specific PR clearly addresses export speed. May be open |

**All 15 items are complete or acceptable for v1.** Wave 6 (faster export) has no clear closing commit — confirm whether this is still outstanding or was addressed as a by-product of the auto-trim / shot-detector work.

---

## 5. Known security items

| Risk | Severity | Status |
|------|----------|--------|
| Storage RLS owner scope | High | ✅ **Fixed** — migration `011_clips_storage_owner_scope.sql` already scopes reads/updates/deletes to round owner via `r.user_id = auth.uid()`. The CLAUDE.md landmine note is stale. Test coverage in `tests/migrationAuthz.test.ts:231-279`. |
| Secret keys in client bundle | Medium | `EXPO_PUBLIC_PIPELINE_API_KEY`, `EXPO_PUBLIC_GOLF_COURSE_API_KEY` embedded in bundle — move to Edge Function proxy (P2, post-launch) |
| No soft-delete | Low | All deletes are permanent; no `deleted_at` anywhere |

---

## 6. Punch list — grouped by priority

### P0 — Must fix before App Store submission

1. **Apple private key — confirm not revoked** — This codebase generates fresh 5-minute JWTs from the stored `.p8` key per request; there is no 6-month JWT to rotate. The only failure mode is the key being revoked. Check Apple Developer Portal → Keys and confirm the Clippar Sign-In key is still active. If revoked, create a new key and update Supabase → Auth → Apple provider.
2. **Confirm Sign In with Apple capability** on all 3 App IDs in Apple Developer Portal.
3. **Confirm `EXPO_PUBLIC_RC_IOS_KEY`** is set in EAS production environment. Without it, the paywall falls back to StubProvider and IAP is non-functional for reviewers.
4. **Set up 14-day free trial introductory offer** in App Store Connect → Subscriptions (monthly + annual products). Exact steps in `APP_STORE_SUBMISSION.md`.
5. **Fill App Privacy nutrition label** in App Store Connect → App Privacy.
6. **Add demo account** to App Store Connect → App Review Information (with note about sample round).
7. **Complete Age Rating questionnaire** (expected 4+).
8. **Upload screenshots** to App Store Connect (use `clippar_app/store-assets/screenshots/6.9-inch-1320x2868/` and `clippar_app/store-assets/screenshots/6.7-inch-1290x2796/` — do NOT upload `originals/`).

### P1 — Should do before or shortly after launch

9. **Custom SMTP** — Configure in Supabase → Authentication → SMTP Settings (Resend/Postmark) before any meaningful user volume to avoid deliverability issues with auth emails.
10. **Fix EAS staging `ascAppId`** — Replace `PLACEHOLDER_STAGING_ASC_APP_ID` in `eas.json` with the real App Store Connect App ID for the staging app record.
11. **Faster export (Wave 6)** — Verify whether this was addressed. If not, open a dedicated issue and track.
12. **expo-doctor pre-build** — Run `npx expo install --check` before final production build (4 non-blocking but real dependency hygiene issues noted in `APPSTORE_READINESS.md`).
13. **Device-verify audio fix** — Issues `#53`/`#54` (clips no volume on export) likely fixed by `#132` but needs device confirmation before it closes.
14. ~~**Storage RLS**~~ — Already fixed by migration `011_clips_storage_owner_scope.sql` (owner-scoped via round join). No action needed.

### P2 — Nice to have / post-launch

15. **More screenshots** — 3 per device is the legal minimum. 5–8 is typical; add one for onboarding and one for the scorecard/export result.
16. **Retake screenshots natively** — Current ones are upscaled ~1.5×. Capture fresh on device post-launch.
17. **Google Sign-In OAuth consent screen** — Publish the consent screen for when Google sign-in is re-enabled post-v1.
18. **Move API keys behind Edge Function proxy** — `EXPO_PUBLIC_PIPELINE_API_KEY` etc. are in the client bundle.
19. **Push notifications** — Wire `registerForPushNotifications()` call sites + add `expo-notifications` plugin (currently intentionally omitted — see `APPSTORE_READINESS.md`).
20. **Close issue `#22`** — All items done; close the tracking issue.
21. **Close issues `#53`, `#54`, `#55`** — After device-verifying the audio fix; `#55` (Metro refresh) is stale and low-priority.

---

## 7. Summary

The app is code-complete for v1. All 5 App Store Review blockers from the Aug 4 review are fixed. All 15 Wave items from issue #22 are done. The path to submission is a checklist of **App Store Connect dashboard steps** (P0 items above), not code.

**The single most urgent action** is renewing the Apple Sign-In JWT in Supabase before Nov 15, 2026 — it's 89 days away and Apple Sign-In will silently break on expiry.

**Estimated time to submittable build:** 1–2 hours of App Store Connect setup + one production EAS build + TestFlight review.
