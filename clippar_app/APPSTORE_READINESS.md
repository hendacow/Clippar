# App Store submission readiness — native / build config

Audit of the **native metadata** rejection-risk class: iOS permission usage
strings, encryption compliance, the privacy manifest, ATT/tracking, icons, and
versioning. IAP, account deletion, Sign-in-with-Apple, and legal pages are
covered by other streams and are out of scope here.

Scope of this PR: `app.config.js`, `eas.json`, native config, icon assets.

Legend: ✅ done in code (this PR) · ✔︎ already correct (verified) · 📋 Henry must
do in App Store Connect / EAS · ⚠️ flag — verify on device.

---

## A. Fixed in code (this PR)

### ✅ iOS permission usage strings — cross-checked against actual code use
Every string now maps to a capability the app really uses, and unused ones were
removed (Apple rejects both vague strings and permissions you don't use).

| Info.plist key | Source | Why it's needed (code) |
|---|---|---|
| `NSCameraUsageDescription` | `expo-camera` plugin | Recording swings (`useCamera.ts`, record screen) |
| `NSMicrophoneUsageDescription` | `expo-camera` plugin | Video audio + audio-based shot detection |
| `NSLocationWhenInUseUsageDescription` | `expo-location` plugin | GPS hole-matching + shot distance (`useLocation.ts`) |
| `NSPhotoLibraryUsageDescription` | `expo-media-library` + `expo-image-picker` | Importing/saving clips |
| `NSPhotoLibraryAddUsageDescription` | `expo-media-library` plugin | Saving highlight reels to Photos |
| `NSBluetoothAlwaysUsageDescription` | `ios.infoPlist` | BLE shot clicker (`useBLE.ts`) |
| `NSBluetoothPeripheralUsageDescription` | `ios.infoPlist` | Same, legacy iOS ≤12 key |
| `NSFaceIDUsageDescription` | `ios.infoPlist` | **Newly added** — `biometrics.ts` unlocks the app via Face ID |

Changes made:
- **Added `NSFaceIDUsageDescription`** — `lib/biometrics.ts` calls
  `LocalAuthentication.authenticateAsync` to gate app access. This string was
  **missing**, which is a hard reject for any app that invokes Face ID.
- **Location → when-in-use only.** `useLocation.ts` uses only
  `requestForegroundPermissionsAsync` + `watchPositionAsync` (no background
  location anywhere). The plugin previously emitted the **"Always"** strings
  (`NSLocationAlwaysAndWhenInUseUsageDescription` /
  `NSLocationAlwaysUsageDescription`); those are now removed (`…: false`) and a
  specific when-in-use string is set. Requesting unused Always-location is a
  common App Review red flag.
- **Removed the `bluetooth-central` background mode.** `useBLE.ts` connects the
  clicker in the foreground while recording and implements no CoreBluetooth
  state restoration (`restoreStateIdentifier`), so the app never actually does
  background Bluetooth. Apple rejects unused background modes. ⚠️ See §D.
- Tightened every string to be specific (generic strings get rejected).

### ✅ `ITSAppUsesNonExemptEncryption = false`
Set in `ios.infoPlist` (this is the literal Info.plist key that
`ios.config.usesNonExemptEncryption` maps to — equivalent and explicit). The app
uses only standard HTTPS/TLS; no proprietary crypto ships in the binary (the
Apple ES256 JWT signing lives server-side in an Edge Function, not the app). This
stops every TestFlight/App Store build from stalling on the export-compliance
question.

### ✅ Privacy manifest (`PrivacyInfo.xcprivacy`)
Expo SDK 54 aggregates each library's bundled manifest at prebuild. Added an
explicit `ios.privacyManifests` block declaring:
- `NSPrivacyTracking: false`, empty `NSPrivacyTrackingDomains` (no tracking — see §C).
- **Required Reason API** declarations for APIs the app + deps touch:
  `UserDefaults` `CA92.1` (AsyncStorage), `FileTimestamp` `C617.1`
  (expo-file-system / expo-sqlite), `DiskSpace` `E174.1` (storage management),
  `SystemBootTime` `35F9.1` (React Native core / boost elapsed-time).

---

## B. Already correct (verified, no change needed)

- ✔︎ **iOS app icon** — `assets/images/icon.png` is 1024×1024 with **no alpha /
  transparency** (verified: no `tRNS` chunk), exactly as Apple requires for the
  marketing icon. Adaptive (`adaptive-icon.png`) and splash (`splash-icon.png`)
  do carry transparency, which is correct for those roles. 📋 Confirm visually
  they're the real branded art, not placeholders.
- ✔︎ **Bundle identifier** — `com.clippar.app` (prod), `.dev`/`.staging` variants
  via `APP_VARIANT`. Team `LBJUXXPJ6H`. Must match the registered App Store
  Connect app (📋 §C).
- ✔︎ **Versioning** — `eas.json` uses `appVersionSource: "remote"` with
  `autoIncrement: true` on the production profile, so the iOS build number is
  managed/incremented by EAS automatically; `version: "1.0.0"` is a sane first
  marketing version. No hardcoded `buildNumber` is needed (and would be ignored
  under remote source).
- ✔︎ **App Transport Security** — no `NSAllowsArbitraryLoads` / cleartext
  exceptions; all traffic is HTTPS.

---

## C. Henry must do — App Store Connect / EAS (not code)

Top priority first:

1. 📋 **App Privacy "nutrition label"** (App Store Connect → App Privacy).
   Declare what's collected and assert **Data is NOT used to track you** (matches
   `NSPrivacyTracking: false`). Expected data types: account email (Supabase
   auth), user content (rounds/clips), coarse/precise location (round play),
   diagnostics (Sentry crash data), purchases (RevenueCat). None linked to
   third-party advertising. See §App-Privacy / ATT below for the evidence.
2. 📋 **Fill the real `ascAppId`** in `eas.json` `submit.production.ios`
   (currently `PLACEHOLDER_PRODUCTION_ASC_APP_ID`) and the staging one, so
   `eas submit` works. Get it from App Store Connect → App → App Information →
   Apple ID.
3. 📋 **Demo account for App Review.** Provide working credentials (and a note
   that Clippar Pro can be exercised via sandbox) in App Store Connect → App
   Review Information. Reviewers cannot create swings on a real course, so also
   add review notes pointing at the in-app **sample round** / tour.
4. 📋 **Screenshots** for required device sizes (6.7"/6.9" iPhone at minimum;
   the app is iPhone-only — `supportsTablet: false`), plus description, keywords,
   support URL, marketing URL, promotional text.
5. 📋 **Age rating** questionnaire. Clippar has no objectionable content →
   expect 4+. Confirm.
6. 📋 **Encryption compliance** — with `ITSAppUsesNonExemptEncryption=false` the
   per-build prompt is skipped; no France declaration / yearly self-classification
   report is required (standard exempt encryption).
7. 📋 **Confirm bundle id `com.clippar.app`** matches the registered app record
   and that the production provisioning profile carries the Sign in with Apple
   and (if used) Apple Pay capabilities. (No Push capability — see "Future" below.)

---

## App Privacy / ATT decision — NO ATT prompt needed

**Decision: Clippar does not require an `NSUserTrackingUsageDescription` / ATT
prompt, and App Privacy should answer "Data is not used to track you."**

Evidence from the code (this branch, `main`):
- **No advertising identifier / tracking APIs.** Repo-wide search for
  `tracking-transparency`, `AppTrackingTransparency`, `IDFA`, `advertisingId`,
  `getAdvertisingId` → **zero hits**. `expo-tracking-transparency` is not a
  dependency.
- **No analytics SDK collecting cross-app data.** No PostHog/Firebase/Amplitude/
  ad-network SDK on `main` (search for `posthog`/`analytics` → none).
- **Sentry** is crash/error diagnostics only — not cross-app advertising
  tracking; declared under "Diagnostics, not used for tracking."
- **RevenueCat** (`react-native-purchases`) manages subscriptions; default config
  collects no IDFA and performs no ATT-triggering tracking.

ATT is required only when you track users across apps/sites owned by other
companies, or share data with data brokers — none of which Clippar does. If an
ad-attribution or cross-app analytics SDK is ever added, revisit: add
`expo-tracking-transparency`, `NSUserTrackingUsageDescription`, the
`requestTrackingPermissionsAsync()` flow, and flip `NSPrivacyTracking` to true.

---

## D. Flags — verify on device (Tier 3)

- ⚠️ **BLE clicker without background mode.** After removing
  `bluetooth-central`, confirm on a real device that the Bluetooth clicker still
  marks shots throughout an active round with the screen on (the recording
  screen keeps the app foregrounded). If a real need for background BLE surfaces
  (e.g. the clicker must work with the screen locked), it must be re-added
  **with** CoreBluetooth state restoration and a justification for App Review —
  not the bare background mode alone.
- ⚠️ **Face ID prompt copy** renders on first biometric unlock — confirm the new
  string reads well.

---

## Future / not in this PR — remote push notifications

**Push is intentionally NOT enabled here.** The `expo-notifications` config
plugin (which grants the iOS `aps-environment` / Remote Push entitlement) is
deliberately omitted, because there is currently **no runtime push path**:

- `registerForPushNotifications()` in `lib/notifications.ts` has **zero call
  sites**.
- There are **no notification listeners** (`addNotificationReceivedListener` /
  `addNotificationResponseReceivedListener`) anywhere.
- `app/profile/notifications.tsx` is local AsyncStorage preference toggles only.

Shipping an `aps-environment` entitlement for a feature with no code path is an
**unused capability** that invites App Review rejection — the opposite of this
PR's goal. The dependency, `lib/notifications.ts`, and the `expo_push_token`
column are left in place untouched for when push is built.

**To enable push later (a separate PR):**
1. Wire a real registration call site for `registerForPushNotifications()` and
   add received/response listeners.
2. Add the `expo-notifications` config plugin to `app.config.js` (grants
   `aps-environment`).
3. Add an **APNs key** in EAS credentials (`eas credentials` → iOS → Push Key) so
   `getExpoPushTokenAsync` issues tokens.
4. Add the Push capability to the production provisioning profile and update the
   App Privacy declaration if push content is personalized.

---

## E. expo-doctor — pre-existing, non-blocking

`npx expo-doctor`: 14/18 pass. The 4 failures are **pre-existing** dependency
hygiene, unrelated to native metadata and not introduced by this PR. They do not
block submission; recommend a separate deps-hygiene pass:
- `@types/react-native` is installed directly — should be removed (types ship
  with `react-native`).
- Duplicate `expo-web-browser` (15.0.10 vs 15.0.11 nested under
  `expo-auth-session`) — de-dupe.
- A few Expo packages are a patch/minor behind the SDK 54 pin — run
  `npx expo install --check` before the final production build.
- React Native Directory metadata warnings (cosmetic).

`tsc --noEmit` is clean.

---

## Quick reference — what changed in `app.config.js`

- `ios.infoPlist`: **+** `NSFaceIDUsageDescription`; **−** `UIBackgroundModes`
  (`bluetooth-central`); reworded Bluetooth strings; kept
  `ITSAppUsesNonExemptEncryption: false`.
- `ios.privacyManifests`: **new** (tracking=false + 4 Required Reason APIs).
- `expo-location` plugin: when-in-use string only; Always keys set to `false`.
- `plugins`: no push plugin added — remote push deferred (see "Future" above).
