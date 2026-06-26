# In-app account deletion

Satisfies **App Store Review Guideline 5.1.1(v)** — any app that supports account
creation must let the user initiate account deletion from inside the app (not just
"contact support"). Without it, submission is rejected.

This doc covers what the feature does, how to deploy/configure it, and the
manual / dashboard steps that can't be automated.

---

## User flow (what the golfer sees)

Profile tab → **Delete Account** (red, bottom of the screen).

1. **Offline guard.** If the device has no connectivity we stop here with a clear
   message — deletion has to reach the server, so we never start a half-delete.
2. **Two-step confirmation.** First alert spells out what is erased (account, all
   rounds, clips, highlight reels — permanent). Second alert ("Are you absolutely
   sure?") confirms that videos already saved to the phone's Photos library stay,
   but everything in the Clippar account is gone.
3. **Active subscription warning.** If RevenueCat reports a live App Store
   subscription, we warn that **deleting the account does NOT cancel the Apple
   subscription** and offer an "Open Settings" shortcut to
   `https://apps.apple.com/account/subscriptions`. The user can still choose
   "Delete anyway".
4. **Re-auth gate.** Before the destructive call we refresh the Supabase session.
   If the refresh token is stale/expired we ask the user to sign in again rather
   than firing a deletion we can't authenticate.
5. **Delete.** Calls the `delete-account` Edge Function (below).
6. **On success:** clear the local RevenueCat entitlement (`iap.reset()`), wipe
   the local SQLite DB + app secure-store keys (`wipeLocalUserData()`), sign out,
   and route to the logged-out login screen.

Client code:
- `app/(tabs)/profile.tsx` — UI + flow (`handleDeleteAccount`, `runAccountDeletion`).
- `lib/api.ts` — `deleteAccount()` invokes the Edge Function.
- `lib/network.ts` — `isConnected()` offline guard.
- `lib/localWipe.ts` — `wipeLocalUserData()` (SQLite + secure-store).
- `lib/storage.ts` — `clearLocalDatabase()`.

---

## Server: the `delete-account` Edge Function

`supabase/functions/delete-account/index.ts`. Runs with the **service role**, so it
can do what the client cannot (delete the `auth.users` row).

**Auth:** only ever deletes the *authenticated* caller. The user's JWT comes in via
`Authorization: Bearer <access_token>`; no user id is read from the body, so the
function can't be aimed at anyone else.

**What it deletes, in order** (`purgeAndDeleteUser`):

1. **Storage objects** under each of the user's rounds — `clips/<roundId>/*` and
   `reels/<roundId>/*`. These do **not** cascade with the auth/profile delete, so
   skipping them would orphan billable storage. Best-effort (a storage error never
   blocks the account delete).
2. **Round subtree, explicitly** — `shots`, `processing_jobs` (both reference
   `profiles(id)` with **no** `ON DELETE` action), then `scores` (by the round
   ids), then `rounds`.
3. **Other user-keyed tables** — `course_presets`, `daily_usage`,
   `hardware_orders`, `admin_users`.
4. **RevenueCat subscriber** — best-effort `DELETE` so the dead account isn't
   tracked. Does **not** cancel an App Store subscription (see below). Skipped if
   `REVENUECAT_SECRET_KEY` is unset.
5. **`profiles`**, then **`auth.admin.deleteUser`** — the account itself.

**Why explicit deletes (not just the cascade):** the `auth.users → profiles`
cascade *would* mostly work, but two FKs make it fragile — `shots.user_id` /
`processing_jobs.user_id` only disappear via their `round_id` cascade, and an
`admin_users` row (FK to `auth.users`, no `ON DELETE`) would **block**
`deleteUser` outright. Deleting each table up front removes that fragility.

**Idempotent:** every `DELETE … WHERE user_id = …` is a no-op the second time, and
an "already deleted" error from `deleteUser` (404 / "not found") is treated as
success — so a retried/duplicated request can't fail.

### Verified

- `deno check supabase/functions/delete-account/index.ts` — clean.
- `deno test --allow-env supabase/functions/delete-account/index.test.ts` —
  6 tests: table coverage, leaf-before-parent ordering, no-rounds path, storage
  removal, idempotent "already gone", and a real failure throwing.
  (Stub the env so the module's client constructs:
  `SUPABASE_URL=http://localhost.test SUPABASE_SERVICE_ROLE_KEY=test deno test --allow-env …`)
- App side: `npm run verify` (typecheck + tests) green.
- Device flow (Tier 3 — real StoreKit + a real account) is the user's to confirm.

---

## Deploy + configure (manual / dashboard steps)

These are **not** automated — run them against the Supabase project before relying
on the feature in production.

1. **Deploy the function:**
   ```bash
   supabase functions deploy delete-account
   ```
2. **Secrets** (Project → Edge Functions → Manage secrets, or CLI):
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — provided automatically by the
     platform for deployed functions; no action needed normally.
   - `REVENUECAT_SECRET_KEY` — **optional.** Set it to also detach the RevenueCat
     subscriber on deletion. Without it, step 4 is skipped (deletion still fully
     succeeds). Set via:
     ```bash
     supabase secrets set REVENUECAT_SECRET_KEY=sk_xxx
     ```
3. **JWT verification:** keep the function's "Verify JWT" setting **on** (default).
   The function additionally re-validates the token with `auth.getUser`.
4. **Smoke test** with a throwaway account: create it, add a round + clip, run the
   in-app delete, then confirm in the dashboard that the `auth.users` row, the
   `profiles`/`rounds`/`shots` rows, and the `clips`/`reels` storage objects are
   all gone.

---

## Things you must do by hand (can't be done server-side)

- **Apple-managed subscriptions cannot be cancelled by us.** StoreKit only lets the
  *user* cancel an auto-renewing subscription, in iOS **Settings → Apple ID →
  Subscriptions** (or `https://apps.apple.com/account/subscriptions`). Deleting the
  Clippar account does not stop Apple from billing. The app warns the user and
  links them to Settings before deletion; this doc is the written record of that
  limitation. We clear our *local* entitlement on delete, but the store
  subscription itself is the user's to cancel.

- **Sign in with Apple token revocation (TODO).** Apple expects apps that offer
  "Sign in with Apple" to revoke the user's tokens via the SiwA REST API on account
  deletion. That needs the Services-ID client secret (a signed JWT) which isn't
  wired up yet. Supabase deletion above fully removes the account and its data
  regardless; token revocation is an additional Apple courtesy/requirement to
  complete before/at submission. Tracked in `docs/APP_STORE_READINESS.md`.

- **Stripe (web) payment records** are intentionally retained by Stripe as the
  accounting source of truth. The app's `hardware_orders` rows are deleted; the
  underlying Stripe charges are not (and shouldn't be).
