# Profile section audit — what actually happens when you tap it

**Date:** 2026-08-04
**Branch:** `fix/profile-settings-that-do-nothing`
**Scope:** `clippar_app/app/(tabs)/profile.tsx` and every screen it pushes to under `clippar_app/app/profile/*`
**Method:** every control traced from the write (storage key / DB column / function call) to the consumer that acts on it. A reader that exists is not evidence; a reader whose behaviour changes is.

All paths below are relative to `clippar_app/`.

---

## Verdict

The pattern holds. **9 controls are broken**, of which one loses footage.

The recurring shape is not "nobody wrote the reader" — it is **the reader was written for one path and the control was labelled for two**. Photos mirroring reads on import and not on record. The clicker screen connects on its own hook instance and the recorder listens on a different one. That is the same failure as Trim Settings (writer never sets the marker the reader requires), and it will keep happening while a control's label is written from intent rather than from the call graph.

Trim Settings is excluded — already being fixed under this branch.

---

## BROKEN — ranked by user impact

### 1. "Save raw clips to Photos" never mirrors a *recorded* clip — PARTIAL
**`app/profile/storage-settings.tsx:100`** · footage loss · **highest impact in this audit**

A golfer turns this on precisely so their rounds survive a reinstall. It works for imported video and does nothing for video the app itself recorded — which is the primary capture path.

| | |
|---|---|
| **Write** | `app/profile/storage-settings.tsx:35` → `lib/storage.ts:524` (`setSetting('mirror_raw_clips_to_photos')`) |
| **Read (import)** | `app/round/import.tsx:624`, acted on at `app/round/import.tsx:666-673` — `MediaLibrary.createAssetAsync`, `photos_asset_id` captured |
| **Read (record)** | **none.** `grep -rn "getMirrorClipsToPhotos" --include="*.ts" --include="*.tsx" .` → 4 hits: `lib/storage.ts:520`, `app/profile/storage-settings.tsx:8,27`, `app/round/import.tsx:51,624`. The record path is absent. |

The recording path persists its clip at **`hooks/useCamera.ts:476`** with no `photos_asset_id` and no `MediaLibrary` call anywhere in the file (`grep -n "MediaLibrary\|photos_asset_id" hooks/useCamera.ts` → no matches).

The consequence chains all the way to recovery: reinstall re-hydration reads `getClipsWithPhotosAssetId` (`lib/storage.ts:499-510`, `WHERE photos_asset_id IS NOT NULL`), invoked from `app/_layout.tsx:175`. A recorded clip has no asset id, so **it is not recoverable even with the toggle on**.

And the screen states the opposite. `app/profile/storage-settings.tsx:160` renders a green tick keyed on `mirrorClips` alone, with the text at **`:163`**: *"Raw clips — mirrored to Photos, will re-import on reinstall."* For a user whose rounds are recorded rather than imported, that green tick is false, and it is the exact claim they would rely on before wiping their phone.

**Fix — wire it up.** Do not weaken the copy; this is the setting's whole purpose.
In `hooks/useCamera.ts`, after `saveLocalClip` at `:476` returns `clipId`, mirror the same way import does:
```ts
if (await getMirrorClipsToPhotos()) {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (perm.status === 'granted') {
    const asset = await MediaLibrary.createAssetAsync(finalUri);
    await setClipPhotosAssetId(clipId, asset.id);   // lib/storage.ts:484
  }
}
```
Do it *after* the row insert and off the recording hot path (`void`), so a Photos write never delays the next shot. `setClipPhotosAssetId` already exists for exactly this ordering — the comment at `app/round/import.tsx:694-696` says it is "kept for symmetry with the record/in-app save flow which mirrors AFTER the clip row is inserted", describing a flow that was never built.

> `hooks/useCamera.ts` is being edited concurrently for the trim fix — coordinate before touching it.

Until it is wired, `app/profile/storage-settings.tsx:160-165` should key the tick on evidence rather than intent (e.g. count clips with a non-null `photos_asset_id`) so the card cannot claim a mirror that did not happen.

---

### 2. Bluetooth Clicker — the screen really connects, and it changes nothing — CONDITIONALLY DEAD
**`app/profile/bluetooth.tsx`** (Scan / device row / Disconnect)

This is not a stub; it allocates a real `BleManager`, scans, connects, subscribes to HID notifications and shows "Clicker Connected". None of it reaches the recorder, for two independent reasons.

**a. Two separate hook instances.** `useBLE()` is called at **`app/profile/bluetooth.tsx:12`** and again at **`hooks/useShutter.ts:191`**. `useBLE` holds all its state in per-instance refs (`managerRef`, `deviceRef`, `pressCallbacks` — `hooks/useBLE.ts:49-53`), with no module-level singleton and no context. The recorder subscribes at **`hooks/useShutter.ts:359`** (`ble.onPress(...)`) — on *its* instance's `pressCallbacks` set. `emitPress` (`hooks/useBLE.ts:97-99`) fires only into the instance that owns the connection, which is the pairing screen's. The two sets never meet.

**b. The connection is destroyed on exit.** `hooks/useBLE.ts:81-87` — unmount cleanup calls `managerRef.current?.destroy()`. Navigating back from the pairing screen tears down the CBCentralManager and the connection with it.

The recorder's own instance can never connect on its own: `startScan` and `connectToDevice` are the only callers of `ensureManager` (`hooks/useBLE.ts:143`, `:196`) and are reachable only from the pairing screen, and `attemptReconnect` deliberately refuses to allocate one — `hooks/useBLE.ts:258` (`if (!managerRef.current ... ) return;`). So `bleConnected` at **`hooks/useShutter.ts:539`** is permanently `false` and the BLE branch of the status label at `:552` is unreachable.

The stored device is dead for the same reason: written at `hooks/useBLE.ts:229` (`ble_device_id`), read only at `hooks/useBLE.ts:266` inside `attemptReconnect`, behind the manager guard above.

Worst of all, the header of `hooks/useShutter.ts:8-10` states the design conclusion outright: *"iOS blocks BLE GATT access to paired HID devices, so the BLE approach in useBLE.ts will NOT work for off-the-shelf shutters."* The clicker that ships with the Clippar kit is such a device. What actually makes it work is `expo-key-event` / volume interception (`hooks/useShutter.ts:27-56`) against an **OS-level** pairing done in iOS Settings — which needs this screen not at all.

**Fix — remove the control.** Replace the scan/connect UI with pairing instructions ("Pair your clicker in iOS Settings › Bluetooth, then press it to test") plus a live press indicator driven by `useShutter().onPress`, which is the signal that actually predicts whether the clicker will work mid-round. Keep `useBLE` only if a custom GATT peripheral is on the roadmap; if it is, it must be hoisted to a provider/singleton so one connection serves both screens — a per-screen hook instance can never do this job.

---

### 3. Notifications — all three switches, dead twice over — DEAD
**`app/profile/notifications.tsx:83-105`** (Reel Ready, Shipping Updates, News & Tips)

**Layer one — nothing reads the preferences.**

| | |
|---|---|
| **Write** | `app/profile/notifications.tsx:72` — `AsyncStorage.setItem(key, String(value))` |
| **Read** | `app/profile/notifications.tsx:61` only — restores the switch positions on mount |

`grep -rn "notif_reel_ready\|notif_shipping\|notif_news" --include="*.ts" --include="*.tsx" .` → 10 hits, **all inside `app/profile/notifications.tsx`**. No sender, client or server, consults them.

**Layer two — the app never registers for push at all.** `registerForPushNotifications()` is defined at **`lib/notifications.ts:16`** and called by nobody: `grep -rn "registerForPushNotifications" --include="*.ts" --include="*.tsx" .` → 2 hits, both inside `lib/notifications.ts` (the definition at `:16`, a log string at `:59`). The whole module is unreferenced — `grep -rn "lib/notifications" --include="*.ts" --include="*.tsx" .` → **0 hits**.

So `expo_push_token` (written at `lib/notifications.ts:50`) is never populated. The column exists (`supabase/migrations/001_initial_schema.sql:19`) and no Edge Function ever reads it to send anything (`grep -rn "expo.dev/--/api/v2/push\|ExponentPushToken" supabase/` → 0 hits). A user who turns every switch on receives nothing; a user who turns them all off was already receiving nothing.

**Fix — remove the screen** for v1, along with the row at `app/(tabs)/profile.tsx:865-870`. Three switches over a subsystem with no client registration and no server sender is precisely the App Review 2.1 shape already scrubbed from Rate Clippar. Reinstate it in the same change that ships push: call `registerForPushNotifications()` after sign-in, add a sender that filters on these keys, and only then show switches. Shipping the switches first is what created this.

---

### 4. Units (Yards / Meters) — DEAD
**`app/(tabs)/profile.tsx:809-860`**

| | |
|---|---|
| **Write** | `app/(tabs)/profile.tsx:823` / `:840` → `setUseMeters(...)`, backed by plain component state at **`app/(tabs)/profile.tsx:142`** |
| **Read** | `app/(tabs)/profile.tsx:827, 832, 845, 850` — all four style the toggle's own highlight |

Not persisted anywhere: no `setSetting`, no `AsyncStorage`, no column. It resets to Meters on every remount. `grep -rn "useMeters" --include="*.ts" --include="*.tsx" .` → 6 hits, all in `app/(tabs)/profile.tsx`.

There is also nothing for it to convert. No screen renders a distance in either unit: `grep -rnE "(yds|yards|metres|meters)" --include="*.tsx" app components` returns only course-ingest plumbing (`components/record/CourseSearch.tsx:160,192,210`) and no display. Hole length is carried through the model (`types/round.ts:28`, `lib/api.ts:624`) and rendered by no component (`grep -rn "lengthMeters" --include="*.tsx" .` → CourseSearch mapping only). Even a fully-wired preference would currently change nothing on screen.

**Fix — remove the control.** Delete `app/(tabs)/profile.tsx:142` and the card at `:808-861`. Bring it back with the first screen that displays a distance (tracer carry, hole yardage), at which point it needs `getSetting`/`setSetting` persistence and a shared formatter — not local state.

---

### 5. "Upgrade" on the cloud-backup Pro alert doesn't open the paywall — DEAD (as labelled)
**`app/profile/storage-settings.tsx:45`**

```ts
{ text: 'Upgrade', onPress: () => router.push('/profile') }
```

`/profile` resolves to `app/(tabs)/profile.tsx` (route groups don't appear in the path), so the user asking to buy Pro is returned to the Profile tab to find "Go Pro" themselves. The paywall exists at `app/paywall.tsx` and the working call is one screen away at **`app/(tabs)/profile.tsx:703`** (`router.push('/paywall')`).

There is a second hazard in that path: `app/profile/` has no `index.tsx` (`ls app/profile/index.tsx` → absent) while `app/(tabs)/profile.tsx` claims the same `/profile` URL. Pushing an ambiguous route from inside the `profile/` stack is worth confirming on device (see below).

**Fix — wire it up.** `router.push('/paywall')`, matching `app/(tabs)/profile.tsx:703`. One line.

---

### 6. "Show me around again" works once per app launch — CONDITIONALLY DEAD
**`app/(tabs)/profile.tsx:900-917`**

| | |
|---|---|
| **Write** | `app/(tabs)/profile.tsx:914` → `replayOnboarding()` → `contexts/OnboardingContext.tsx:199-204` clears `onboarding.tour_done` and sets `flags.tourDone = false` |
| **Read** | `components/onboarding/OnboardingHost.tsx:41-62` — the effect that calls `startTour()` at `:59` |

The guard at **`components/onboarding/OnboardingHost.tsx:49`** (`if (queuedTourStart.current) return;`) is set `true` at `:51` and **never reset** — `grep -n "queuedTourStart" components/onboarding/OnboardingHost.tsx` → `:26` (declare), `:49` (read), `:51` (set). No cleanup, no reset on `tourDone` flipping back.

Fires: first tap after a cold start (for a returning user `flags.tourDone` is true at mount, so the effect returns at `:45` before arming the ref).
Does nothing: every subsequent tap in the same app session. Flags are cleared, no tour appears, no feedback — the user taps "Show me around again" and lands on Home with nothing happening.

**Fix — wire it up.** Reset the latch when the tour is re-armed, in `components/onboarding/OnboardingHost.tsx`:
```ts
useEffect(() => { if (!flags.tourDone) queuedTourStart.current = false; }, [flags.tourDone]);
```
The ref exists to stop the effect double-firing within one arming, not to make replay single-shot for the life of the process.

---

### 7. "Retry backup" is silent when cloud backup was turned off after a failure — CONDITIONALLY DEAD
**`app/profile/rounds.tsx:250-275`** (Backup & status → "Backup failed" section)

| | |
|---|---|
| **Write** | `app/profile/rounds.tsx:134` → `processUploadQueue()` |
| **Read** | `lib/uploadQueue.ts:96-105` — returns immediately if `!cloudBackupOn`, and `:106-109` if `!subscribed` |

Normally consistent: rows are only enqueued while backup is on (`lib/uploadQueue.ts:64-70`). But the failed rows are durable and the section header is driven by them (`app/profile/rounds.tsx:144`, `queueStatus === 'error'`). Turn cloud backup off — or let Pro lapse — after a failure and the "Backup failed" bucket stays on screen forever with a Retry button that spins, returns, and changes nothing. No alert, no explanation. Same class as the old Clear Cache: an action that reports success-shaped nothing.

**Fix — wire it up.** Have `handleRetryBackup` check `getCloudBackupEnabled()` / `getProStatus()` first and say *why* ("Cloud backup is off — turn it on in Storage & Backup to finish these uploads", with a link), instead of calling into a function that silently no-ops.

---

### 8. Storage screen's "Clear cache" clears nothing for almost everyone, and buzzes success — DEAD (in practice)
**`app/profile/storage-settings.tsx:182-206`**

| | |
|---|---|
| **Write** | `app/profile/storage-settings.tsx:73` — deletes exactly one directory, `cacheDirectory/recovered-clips/` |
| **Who fills it** | `app/round/editor.tsx:1068` only — clips re-downloaded from the cloud, i.e. Pro **and** cloud backup on **and** a prior recovery |

For every other user the directory does not exist, `deleteAsync({ idempotent: true })` succeeds having deleted nothing, and `:76-77` fires the success haptic and "Done — Cache cleared." This is the *same bug* that was just fixed one screen up: the Profile-tab Clear Cache now measures bytes and distinguishes freed / nothing-to-free / failed (`app/(tabs)/profile.tsx:464-480`).

The real implementation already exists and is not called from here — `lib/cacheReclaim.ts` sweeps thumbnails, temp exports and aged-out `recovered-clips/` (`lib/cacheReclaim.ts:51`, `:82`) and returns a byte count.

**Fix — remove this control**, since `app/(tabs)/profile.tsx:890-895` covers it one tap away and two Clear Cache buttons with different behaviour is worse than one. If it stays, it must call `clearDisposableCaches()` and report bytes exactly as the profile-tab row does.

---

### 9. Edit Profile stores a device-local file path as the avatar when the upload fails — PARTIAL
**`app/profile/edit.tsx:109`**

All four fields persist and re-read correctly (see working list). The avatar has one bad branch: when the Supabase Storage upload fails, `:109` sets `avatar_url` to the **local** `asset.uri` (`file:///var/mobile/...`), which is then written to the profile row at `:135` → `:150` (`updateProfile`) → `lib/api.ts:69-81`, and rendered at `app/(tabs)/profile.tsx:588-593`.

It looks right on the device that set it and is a dead link everywhere else — another device, after reinstall, and anywhere server-side. The comment at `:107` treats this as a placeholder, but it is committed to the database like any real value.

**Fix — wire it up.** On upload failure, keep the new image in local component state for preview only, exclude `avatar_url` from the `updates` object at `:132-136`, and tell the user the photo did not save. Never persist a `file://` URI into a column other clients read.

---

## Verified working

Traced end to end; the effect is real.

- **Backup & status** row — `app/(tabs)/profile.tsx:725` → `app/profile/rounds.tsx`; counts from `getRounds()` (`app/(tabs)/profile.tsx:153-162`) render at `:744`/`:757`; list, buckets, pull-to-refresh and pipeline-event refetch all live (`app/profile/rounds.tsx:102-115`). *(Retry button caveat — finding 7.)*
- **Storage & Backup → Cloud backup switch** — `app/profile/storage-settings.tsx:52` → `lib/storage.ts:532`; read and acted on at `lib/uploadQueue.ts:65` (enqueue gate), `lib/uploadQueue.ts:98` (drain gate), `app/(tabs)/record.tsx:1542` (end-of-round enqueue), `app/round/import.tsx:625`. The Pro gate at `:39-49` is correct. *(Its "Upgrade" button is finding 5.)*
- **Orders** — `app/(tabs)/profile.tsx:876` → `app/profile/orders.tsx:23` → `lib/api.ts:701-720`, real `hardware_orders` query, rendered at `:74-138`. Tracking button opens Auspost with a fallback alert (`:118-133`). Shop CTA correctly gated on `config.shop.inAppShopEnabled` (`constants/config.ts:121`).
- **Redeem a code** — `app/profile/redeem.tsx:68` → `lib/redeemCode.redeemCode`; on success emits `emitSubscriptionChanged()` (`:76`) which `hooks/useSubscription.ts:46` consumes to re-run `getProStatus()`. Double-submit guarded by a ref (`:49`, `:62`).
- **Clear Cache (Profile tab)** — `app/(tabs)/profile.tsx:464` → `lib/cacheReclaim.clearDisposableCaches`, byte count reported, three outcomes kept distinct (`:465-480`).
- **Feedback** — `app/(tabs)/profile.tsx:960` opens `mailto:` with the build version stamped in, `.catch` falls back to showing the address (`:964-969`).
- **Privacy Policy / Terms** — `app/(tabs)/profile.tsx:1005` / `:1011`, direct `Linking.openURL` to live URLs.
- **Sign Out** — `app/(tabs)/profile.tsx:206` → `clearAccountLinkedCaches()` *before* `signOut()` (`:183-185`, ordering is load-bearing and correct); the "Remove my videos too" branch calls `removeLocalMediaForCurrentUser()` (`:198`).
- **Delete Account** — `app/(tabs)/profile.tsx:404` → real re-auth challenge per provider with an identity re-check (`:271-337`), `deleteAccount()` → `lib/api.ts:1496` Edge Function, then `iap.reset()`, `wipeLocalUserData()`, `signOut()` (`:357-369`). Offline pre-check and live-subscription warning both fire.
- **Edit Profile fields** — Display Name / Handicap / Home Course all write via `updateProfile` (`app/profile/edit.tsx:150` → `lib/api.ts:69-81`) and re-read via `getProfile` (`lib/api.ts:37`), rendering at `app/(tabs)/profile.tsx:612`, `:619`, `:630`. Handicap range-validated at `edit.tsx:140`. Email is read-only *and says so* (`:305-307`) — correct, not dead. *(Avatar caveat — finding 9.)*
- **Clippar Pro / Go Pro row** — `app/(tabs)/profile.tsx:703` → `app/paywall.tsx`; card correctly hidden when `subscriptionStatus === 'active'` (`:657`), status sourced from `hooks/useSubscription.ts`.
- **Show me around again** — first invocation per app launch only (finding 6).
- **Dev-only rows** (Trim Sandbox, Tracer Sim, Diagnostics, Verify My Rounds) — all correctly behind `__DEV__` at `:787`, `:921`, `:986`; invisible in production. The Verify-Rounds false-alarm noted in the brief is contained by that gate.

---

## Could not verify statically — needs a device check

1. **Photos mirroring on the record path (finding 1).** Static trace says recorded clips are never mirrored. Confirm: enable "Save raw clips to Photos", record a live round, then query `SELECT id, photos_asset_id FROM local_clips WHERE round_id = ?` — expect `photos_asset_id` NULL for every recorded clip and non-NULL for imported ones. Then check the camera roll contains the imported clips only.
2. **Clicker press reaching the recorder (finding 2).** Pair a clicker on `app/profile/bluetooth.tsx` until it reads "Clicker Connected", navigate to Record, and press it. Static trace says presses do not arrive over BLE and any that work come from the OS-level HID path. Isolate by testing *without* pairing in-app: pair only in iOS Settings and confirm the clicker still starts a shot.
3. **`router.push('/profile')` from inside the profile stack (finding 5).** `/profile` is claimed by `app/(tabs)/profile.tsx` while `app/profile/` has no `index.tsx`. Confirm whether the Upgrade button lands on the Profile tab or on `+not-found` — either way it is not the paywall, but the fix's urgency differs.
4. **Push permission prompt.** Static trace says `registerForPushNotifications()` is never called, so the app should never show the iOS notification prompt. Confirm on a fresh install: if a prompt does appear, something outside this trace is registering and finding 3 needs re-checking.
5. **`recovered-clips/` on a free account (finding 8).** Confirm `cacheDirectory/recovered-clips/` never exists for a non-Pro user, which is what makes that Clear cache a guaranteed no-op with a success buzz.
