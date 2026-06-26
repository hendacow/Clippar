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
- `lib/api.ts` — `deleteAccount()` invokes the Edge Function; `linkAppleCredentials()`.
- `lib/network.ts` — `isConnected()` offline guard.
- `lib/localWipe.ts` — `wipeLocalUserData()` (SQLite + secure-store).
- `lib/storage.ts` — `clearLocalDatabase()`.
- `hooks/useAuth.ts` — `signInWithApple()` captures the Apple authorization code
  and links it (see Sign-in-with-Apple revocation below).

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
4b. **Sign-in-with-Apple revocation** (`revokeAppleForUser`) — if the user linked
   Apple (a refresh token is in `apple_credentials`) and Apple signing secrets are
   configured, revoke the token at `https://appleid.apple.com/auth/revoke` using a
   server-generated client secret, then delete the credentials row. Best-effort:
   skipped cleanly for non-Apple users and never blocks deletion if Apple errors.
   See the dedicated section below.
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

- `deno check` — clean for `delete-account`, `apple-link`, and `_shared/apple.ts`.
- `deno test --allow-env --allow-net supabase/functions/` — 14 tests:
  - delete-account (10): table coverage incl. `apple_credentials`,
    leaf-before-parent ordering, no-rounds path, storage removal, idempotent
    "already gone", real-failure throw, and the four `revokeAppleForUser` cases
    (no env → skip, no stored token → skip, posts to `/auth/revoke`, swallows an
    Apple error).
  - `_shared/apple` (4): JWT payload decode, malformed-token reject, ES256 client
    secret structure + signature verify, escaped-newline PEM tolerance.
  - (Stub the env so the module's client constructs:
    `SUPABASE_URL=http://localhost.test SUPABASE_SERVICE_ROLE_KEY=test deno test --allow-env --allow-net …`)
- App side: `npm run verify` (typecheck + tests) green.
- **Device / Apple-sandbox steps the user must run** (can't be done here): sign in
  with a real Apple ID on a dev build → confirm an `apple_credentials` row appears;
  then delete the account and confirm the Apple ID no longer lists Clippar under
  **Settings → Apple ID → Sign in with Apple** (revocation removes it). Tier-3.

---

## Sign-in-with-Apple token revocation

Apple requires apps offering "Sign in with Apple" to **revoke the user's Apple
token** when they delete their account (enforced under 5.1.1(v)). Revocation needs
a token Apple issued, but the native sign-in (`signInWithIdToken`) only ever sees
the **identity token** — never a refresh token. So we capture one at sign-in:

1. **Sign-in (`hooks/useAuth.ts` → `lib/api.ts`).** `signInWithApple` keeps the
   one-time `authorizationCode` from `AppleAuthentication.signInAsync` and, after
   the Supabase sign-in succeeds, fire-and-forgets `linkAppleCredentials(code,
   identityToken)`. This never blocks or fails sign-in.
2. **Exchange + store (`supabase/functions/apple-link`).** Authenticated by the
   user's Supabase JWT. Reads the `aud` (bundle id / client_id) and `sub` from the
   identity token, allowlists the client_id, generates an ES256 client secret from
   the `.p8`, exchanges the code at `https://appleid.apple.com/auth/token`, and
   upserts the `refresh_token` + `client_id` into `apple_credentials` (service-role
   only; migration `012`).
3. **Revoke on deletion (`delete-account` → `revokeAppleForUser`).** Looks up the
   stored token, generates a client secret for the **same** client_id, and POSTs to
   `https://appleid.apple.com/auth/revoke` (`token_type_hint=refresh_token`) before
   removing the row. Best-effort — a non-Apple user or an Apple outage never blocks
   the data deletion.

Crypto/helpers live in `supabase/functions/_shared/apple.ts` (client-secret JWT
generation via Web Crypto, code exchange, revoke). No external dep; the `.p8` is
the same key already used for SiwA login.

**Limitation:** if the code exchange at sign-in fails (e.g. the code expired before
`apple-link` ran, or Apple secrets weren't configured at the time), there's no
refresh token to revoke later. The account + data are still fully deleted; only the
Apple-side token revocation is skipped. Re-signing in re-links and stores a fresh
token.

---

## Deploy + configure (manual / dashboard steps)

These are **not** automated — run them against the Supabase project before relying
on the feature in production.

1. **Apply the migration** that adds `apple_credentials` (service-role-only table):
   ```bash
   supabase db push        # or run supabase/migrations/012_apple_credentials.sql
   ```
2. **Deploy the functions:**
   ```bash
   supabase functions deploy delete-account
   supabase functions deploy apple-link
   ```
3. **Secrets** (Project → Edge Functions → Manage secrets, or CLI):
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — provided automatically by the
     platform for deployed functions; no action needed normally.
   - `REVENUECAT_SECRET_KEY` — **optional.** Set it to also detach the RevenueCat
     subscriber on deletion. Without it, step 4 is skipped (deletion still fully
     succeeds). Set via:
     ```bash
     supabase secrets set REVENUECAT_SECRET_KEY=sk_xxx
     ```
   - **Apple Sign-in revocation secrets** (required for SiwA revocation — without
     them `apple-link` no-ops and `delete-account` skips revocation, both
     gracefully). Reuse the **same `.p8` key, Key ID, and Team ID** already
     configured for SiwA login in the Supabase dashboard (Auth → Providers →
     Apple). See `SETUP_AUTH.md` §2.
     ```bash
     supabase secrets set APPLE_TEAM_ID=LBJUXXPJ6H
     supabase secrets set APPLE_KEY_ID=<10-char key id of the .p8>
     # the full .p8 PEM incl. the BEGIN/END lines:
     supabase secrets set APPLE_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
     # optional override of the allowed bundle ids (defaults to the three below):
     supabase secrets set APPLE_ALLOWED_CLIENT_IDS=com.clippar.app,com.clippar.app.dev,com.clippar.app.staging
     ```
     Note: for **native** Sign in with Apple the client_id is the app's **bundle
     id** (not the Services ID used for web OAuth). The function reads it from the
     identity token's `aud` and allowlists it, so dev/staging/prod all work.
4. **JWT verification:** keep both functions' "Verify JWT" setting **on** (default).
   Each also re-validates the token with `auth.getUser`.
5. **Smoke test** with a throwaway account: create it, add a round + clip, run the
   in-app delete, then confirm in the dashboard that the `auth.users` row, the
   `profiles`/`rounds`/`shots`/`apple_credentials` rows, and the `clips`/`reels`
   storage objects are all gone. For Apple users, also confirm the app is removed
   from the Apple ID's "Sign in with Apple" list.

---

## Things you must do by hand (can't be done server-side)

- **Apple-managed subscriptions cannot be cancelled by us.** StoreKit only lets the
  *user* cancel an auto-renewing subscription, in iOS **Settings → Apple ID →
  Subscriptions** (or `https://apps.apple.com/account/subscriptions`). Deleting the
  Clippar account does not stop Apple from billing. The app warns the user and
  links them to Settings before deletion; this doc is the written record of that
  limitation. We clear our *local* entitlement on delete, but the store
  subscription itself is the user's to cancel.

- **Sign in with Apple token revocation — DONE** (see the dedicated section
  above). The only manual step is setting the `APPLE_TEAM_ID` / `APPLE_KEY_ID` /
  `APPLE_PRIVATE_KEY` Edge Function secrets (same `.p8` as SiwA login) and applying
  migration `012` + deploying the `apple-link` function. Until those secrets are
  set the revocation no-ops gracefully (data deletion is unaffected).

- **Stripe (web) payment records** are intentionally retained by Stripe as the
  accounting source of truth. The app's `hardware_orders` rows are deleted; the
  underlying Stripe charges are not (and shouldn't be).
