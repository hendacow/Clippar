# Bug Hunt Report — Clippar Golf App

Scanned areas (per assignment — excluding files owned by other agents):
- `hooks/*.ts` (except `useCamera.ts`, `useEditorState.ts`)
- `lib/*.ts` (except `r2.ts`, `media.ts`)
- `contexts/*.tsx` (skipping active edits in `UploadContext.tsx`)
- `components/**/*.tsx` (except `library/ScoreCollection.tsx`, `record/RecordingIndicator.tsx`, `editor/ClipTrimModal.tsx`)
- `app/(auth)/*`, `app/(tabs)/_layout.tsx`
- `app/round/[id].tsx`, `app/round/preview.tsx`
- `app/profile/*`

Totals: 23 findings — **4 CRITICAL**, **7 HIGH**, **8 MED**, **4 LOW**.

---

## CRITICAL

### C1 — Rules of Hooks violation in `PreviewPlayer.tsx` NativeClipPlayer
**File:** `components/editor/PreviewPlayer.tsx:80`
**Symptom:** On web (`ExpoVideo === null`), `NativeClipPlayer` does `if (!ExpoVideo) return null;` BEFORE calling `useVideoPlayer` and `useEffect`. Hooks called conditionally — React will throw "Rendered fewer hooks than expected" if this component is ever rendered without ExpoVideo available.
**Root cause:** Early return before hook calls breaks React's hook ordering invariant.
**Fix:** Short-circuit at the caller (`isNative && ExpoVideo ?`) — which it already does — AND remove the `if (!ExpoVideo) return null;` guard since the parent already gates this. Or restructure to always call hooks before any conditional return.

### C2 — Rules of Hooks violation in `app/round/preview.tsx` NativeClipPlayer
**File:** `app/round/preview.tsx:68`
**Symptom:** Same as C1 — `if (!ExpoVideo) return null;` before `useVideoPlayer(uri, ...)` and `useEffect`.
**Root cause:** Same.
**Fix:** Same pattern as C1.

### C3 — Rules of Hooks violation in `useShutter.ts`
**File:** `hooks/useShutter.ts:88`
**Symptom:** `const keyEventResult = keyEventAvailable ? useKeyEvent() : { keyEvent: null };` conditionally calls a hook. Although `keyEventAvailable` is set at module-load and never changes between renders in practice, this is still a direct violation of Rules of Hooks — linters and React DevTools will flag it, and any HMR reload that re-evaluates the module can desync the hook order.
**Root cause:** Ternary around a hook call.
**Fix:** Always call a hook unconditionally — use a stable wrapper that returns `{ keyEvent: null }` when the module is unavailable, never a raw ternary.

### C4 — `round.total_score !== null` check is wrong for undefined → UI renders "undefined"
**File:** `app/round/[id].tsx:466`, `app/round/[id].tsx:488–492`
**Symptom:** The score strip conditional is `{round.total_score !== null && (...)}`. If `total_score` is `undefined` (e.g. round in `recording` state, no total_score column yet), `undefined !== null` is true → the block renders, and the screen shows the literal word `undefined` in several places. Same pattern for `round.score_to_par`.
**Root cause:** Supabase returns `undefined` for missing numeric columns, not `null`, in some scenarios.
**Fix:** Use `round.total_score != null` (loose equality) or explicit `typeof round.total_score === 'number'`.

---

## HIGH

### H1 — `ScoreEntrySheet` auto-dismiss timer fires with stale strokes/putts values
**File:** `components/record/ScoreEntrySheet.tsx:42–47`, line 55–58
**Symptom:** User adjusts strokes/putts but if 5 s elapse without another tap, the sheet auto-confirms with the INITIAL strokes/putts the first time they adjusted — not the latest. Silent data corruption of scorecard.
**Root cause:** `resetAutoDismiss` is `useCallback(..., [])` (empty deps), so it captures the first `handleConfirm` which itself captured the initial `strokes`/`putts`. `adjustStrokes`/`adjustPutts` call `resetAutoDismiss()` each time, but all of those call the same stale `handleConfirm`.
**Fix:** Use a ref for the live `handleConfirm`, or put `handleConfirm` in `resetAutoDismiss` deps, or use `setTimeout(handleConfirmRef.current, 5000)` pattern.

### H2 — `useRound.endRound` captures stale `state`
**File:** `hooks/useRound.ts:255–286`
**Symptom:** `endRound` references `state` closed over at render time. If `endRound` is triggered right after a `setState` (e.g. final score just added), the closure may read the previous state. Uploads could report last-but-one `total_score`.
**Root cause:** `endRound` is `useCallback(..., [state])` but reads `state` eagerly; the callback is regenerated each state change, so a tap captured by the old handler fires with the old state.
**Fix:** Move the body into a `setState(prev => ...)` functional update, or pass `state` explicitly as an argument, OR use a `stateRef`.

### H3 — `subscription_status === 'active'` with no `expires_at` returns false (lifetime users locked out)
**File:** `lib/subscription.ts:15–24`
**Symptom:** Users with lifetime / perpetual subscriptions (no expiry) are treated as expired. `checkSubscription` returns `false` → paywall blocks recording.
**Root cause:** `if (profile.subscription_expires_at && new Date(...) > new Date())` — the truthy check on `subscription_expires_at` short-circuits. Missing branch where status is `active` and there's no expiry.
**Fix:** If `status === 'active'` and `expires_at == null`, return true.

### H4 — `lib/pipeline.ts` & `UploadContext` fetch() without timeout can hang forever
**File:** `lib/pipeline.ts:18–32`, `contexts/UploadContext.tsx:126`, `contexts/UploadContext.tsx:365`, `386`, `412`
**Symptom:** On flaky cellular, RN fetch will stall indefinitely — users see a frozen progress card with no error, no retry.
**Root cause:** No AbortController/timeout on fetch.
**Fix:** Wrap each fetch with a 30 s AbortController or use `Promise.race` with a timeout. (Agent I owns UploadContext, so leave that alone.) Fix `lib/pipeline.ts` at minimum.

### H5 — `lib/notifications.ts` crashes caller on Expo push token failure
**File:** `lib/notifications.ts:29–32`
**Symptom:** `Notifications.getExpoPushTokenAsync({ projectId: undefined })` throws. `registerForPushNotifications` has no try/catch around it; any async caller propagates the error. In production, this has crashed first-launch onboarding in similar apps when the EAS `projectId` is missing from `expo-constants`.
**Root cause:** Missing try/catch; also missing guard for missing projectId.
**Fix:** Guard the token fetch in try/catch and return null on failure.

### H6 — `lib/sharing.ts` `getLocalVideoUri` silently returns stale URI on download failure
**File:** `lib/sharing.ts:45–47`
**Symptom:** If `download.downloadAsync()` returns `undefined` (network failure), the function returns the empty `localUri` as if it succeeded. Downstream code tries to share a nonexistent file; share sheet shows broken preview or fails silently.
**Root cause:** `return result?.uri ?? localUri;` — fallback to `localUri` which doesn't exist.
**Fix:** Throw an explicit "Download failed" error.

### H7 — `app/profile/rounds.tsx` polling interval re-created on every `rounds` change
**File:** `app/profile/rounds.tsx:288–296`
**Symptom:** The polling `useEffect` depends on `rounds`. Every time `rounds` updates (every 10 s poll), the interval is cleared and a new one scheduled — effectively doubles requests on slow renders and makes cancellation race-prone.
**Root cause:** Dependency on the array that the poll itself updates.
**Fix:** Use `useRef` to track "has active jobs" or switch to `useMemo` for the flag, depending only on a stable boolean.

---

## MED

### M1 — `useProcessingStatus.startPolling` can leak intervals on repeat calls
**File:** `hooks/useProcessingStatus.ts:42–49`
**Symptom:** Calling `startPolling()` twice in a row creates two intervals; only the second is cleared on unmount.
**Fix:** Clear any existing `intervalRef.current` before setting a new one.

### M2 — `PreviewPlayer` clip-end interval survives clip cleanup
**File:** `components/editor/PreviewPlayer.tsx:93–112`
**Symptom:** In `NativeClipPlayer`, the 100 ms interval runs until cleanup. If the player ref becomes disposed before cleanup, `player.currentTime` access may throw — swallowed, but causes dropped-frame stutters.
**Fix:** Bail out if `player` is null-ish before reading `currentTime`.

### M3 — `useShutter` volume-manager cleanup may fail if first render raced
**File:** `hooks/useShutter.ts:105–122`
**Symptom:** `subscription?.remove?.()` — ok, but `VolumeManager.setVolume(0.5)` is also called every press. If user is on a call (audio session busy), this throws silently (wrapped in try/catch, so OK) but also resets their call audio level. Unexpected behavior.
**Fix:** Only reset volume if we detect audio isn't captured by another session. Accept as-is for now; low risk.

### M4 — `components/library/HeroReel.tsx` / `RoundCardHorizontal.tsx` `new Date(round.date)` shows "Invalid Date"
**File:** `components/library/HeroReel.tsx:181`, `components/library/RoundCardHorizontal.tsx:190`, `app/round/[id].tsx:504`
**Symptom:** If `round.date` is null/undefined (draft round, no date yet), `new Date(null)` → epoch, `new Date(undefined)` → Invalid Date → `.toLocaleDateString()` returns literal string "Invalid Date".
**Fix:** Guard with `round.date ? new Date(round.date).toLocaleDateString(...) : '—'`.

### M5 — `lib/storage.ts` `getDatabase` race on first cold start
**File:** `lib/storage.ts:5–12`
**Symptom:** Two concurrent calls to `getDatabase()` on app cold start can both see `db == null` and both run `initTables()` + `migrateEditorColumns()` twice. SQLite `CREATE TABLE IF NOT EXISTS` is idempotent, but `ALTER TABLE ADD COLUMN` may throw "duplicate column" warnings (caught, OK). Still, the double `openDatabaseAsync` causes momentary file-handle pressure.
**Fix:** Introduce a `dbPromise` that memoizes the initialization promise so the first caller wins.

### M6 — `components/record/CourseSearch.tsx` cleanup missing on unmount
**File:** `components/record/CourseSearch.tsx:56–63`
**Symptom:** If the user types then navigates away before the 300 ms debounce fires, the pending `searchCourses` still runs and calls `setResults` on an unmounted component → "Can't perform a React state update on an unmounted component" warning.
**Fix:** Add a cleanup `useEffect` that clears the debounce timeout on unmount, and gate `setResults` on an `isMounted` ref.

### M7 — `contexts/UploadContext.tsx` — direct Modal URL hardcoded (avoid touching per owner assignment, flagging only)
**File:** `contexts/UploadContext.tsx:366`
**Symptom:** `https://hendacow--clippar-shot-detector-run-full-pipeline.modal.run` is hardcoded. If Modal redeploys under a new user namespace, requests fail silently. Not caught by the try/catch above — it just rolls through to the next fallback.
**Fix:** Move to `config.ts`.

### M8 — `ShareSheet` reopens with stale `saveState` after re-open
**File:** `components/shared/ShareSheet.tsx:40–49`
**Symptom:** When `visible` toggles off then on with same `roundId`, both `setSaveState('idle')` and `setShareState('idle')` reset, but `shareLink` isn't cleared, so if `getShareUrl` returns a different link on re-open, users briefly see the OLD link copied.
**Fix:** `setShareLink(null)` before fetching.

---

## LOW

### L1 — `useBLE.ts` retry backoff `1000 * Math.pow(2, retryCount)` reaches 32s at retry=5
**File:** `hooks/useBLE.ts:224`
**Symptom:** Max delay is 32s (capped at 30s by Math.min). Minor — user waits up to 30s between retries.
**Fix:** Fine as-is; include jitter.

### L2 — `signup.tsx` does not trim `email` before sending to Supabase
**File:** `app/(auth)/signup.tsx:39`
**Symptom:** Trailing whitespace in email is trimmed already (`.trim()`), so OK. But the displayed confirmation message at line 71 uses the un-trimmed `email` state → shown with whitespace.
**Fix:** Trim in the success message too.

### L3 — `MusicPicker.tsx` duration formatting crashes on negative / NaN values
**File:** `components/editor/MusicPicker.tsx:150`
**Symptom:** `Math.floor(NaN / 60)` = `NaN`, `NaN:NaN` shown if DB has bad data.
**Fix:** Guard with `?? 0`.

### L4 — `app/profile/rounds.tsx` — `item.id` key uses truthy coercion, but `round.id` always present, so OK; still, `SectionList` uses same keyExtractor for sections and items which can mis-key.
**File:** `app/profile/rounds.tsx:384`
**Symptom:** SectionList section key defaults to the title; if two sections share identical titles (can't happen here but fragile).
**Fix:** Explicit `renderSectionHeader` key or `keyExtractor` that namespaces.

---

## Fixes Implemented

See commit for details. Implemented **C1, C2, C3, C4, H1, H2, H3, H4 (pipeline.ts only), H5, H6, H7**.
MED/LOW items are left as follow-up.
