# Clippar — lifetime redemption codes: the shared contract

Three agents are working in this ONE tree (`/Users/hendacow/projects/clippar-codes`,
branch `feat/lifetime-redemption-codes`, cut from `origin/main` @ d62ad20).
This file is the interface between them. **Do not change anything in this file.**
If you believe the contract is wrong, say so in your final report — do not
unilaterally redesign it, because the other agents are building against it.

## Who owns which files

| Agent | Owns (may create/edit) | Must NOT touch |
|---|---|---|
| **backend** | `clippar_app/supabase/migrations/018_*.sql`, `clippar_app/supabase/functions/redeem-code/**`, `scripts/generate-redemption-codes.ts` | anything under `app/`, `components/`, `hooks/`, `lib/` |
| **client** | `clippar_app/lib/redeemCode.ts`, `clippar_app/app/profile/redeem.tsx`, `clippar_app/app/paywall.tsx`, `clippar_app/app/(tabs)/profile.tsx`, `clippar_app/lib/subscription.ts`, `clippar_app/constants/config.ts`, `clippar_app/tests/redeemCode*.test.ts` | anything under `supabase/` |
| **security** | `clippar_app/supabase/migrations/019_*.sql`, plus a written report | migrations 018, `redeem-code/**`, and every file the client agent owns |

Two agents editing the same file will destroy each other's work. Stay in your lane.

## The feature, in one paragraph

Henry hands a printed code to an ambassador / early supporter. They sign in to
Clippar, paste the code once, and get **Clippar Pro for life** — no App Store
purchase, no expiry. Each code works exactly once. Nobody can brute-force a
code, mint one, read one out of the database, or grant themselves the
entitlement directly.

## Wire contract — edge function `redeem-code`

`POST /functions/v1/redeem-code`, `verify_jwt` ON (the caller must be signed in;
the granted user is taken from the **verified JWT**, never from the body).

Request body:
```json
{ "code": "CLIP-4T7Q-9XKM-2WRB-J5NH" }
```

Responses — the client switches on `error`, so these strings are load-bearing:

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true, "grant": "lifetime" }` | Redeemed. Pro is live. |
| 200 | `{ "ok": true, "grant": "lifetime", "alreadyOwned": true }` | This same user already redeemed this same code. Idempotent replay, not an error. |
| 400 | `{ "ok": false, "error": "invalid" }` | Not a real code, already used by someone else, revoked, or expired. **Deliberately merged into one message** — see below. |
| 400 | `{ "ok": false, "error": "malformed" }` | Failed the format check before any DB work. |
| 401 | `{ "ok": false, "error": "unauthorized" }` | No / bad JWT. |
| 429 | `{ "ok": false, "error": "rate_limited", "retryAfterSeconds": 900 }` | Too many attempts. |
| 500 | `{ "ok": false, "error": "server" }` | Never leak the cause to the caller; log it. |

## Code format

- Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U —
  they are the characters people misread and mistype).
- 16 random characters = **80 bits of entropy**, displayed grouped for humans:
  `CLIP-XXXX-XXXX-XXXX-XXXX`.
- Normalisation before hashing, applied identically by generator and verifier:
  uppercase → strip everything not in the alphabet after mapping the classic
  confusions `I`→`1`, `L`→`1`, `O`→`0` → drop the `CLIP` prefix if present.
  A single shared `normalizeCode()` must be the only implementation.

## Entitlement

Redemption sets, in one transaction, service-role only:
- `profiles.subscription_status = 'active'` and `profiles.subscription_expires_at = NULL`.
  `lib/subscription.ts:checkSubscriptionDeterminate` **already** reads
  `status === 'active'` with a null expiry as lifetime, so nothing downstream
  needs to change for the gate to open.
- a row in `user_entitlements` recording *why* (source = `redemption_code`,
  which code, when) so a lifetime grant is auditable and revocable later.

`profiles` UPDATE is already revoked from `authenticated` (migration 013:34-45 —
only display_name, email, handicap, home_course, avatar_url, ble_device_id,
expo_push_token, updated_at are grantable). Do not widen that grant. If you find
any path that lets a signed-in client write `subscription_status`, that is a
P0 finding — report it loudly.

## Pricing (client agent)

`constants/config.ts` currently says `monthlyPriceAud: 1999, annualPriceAud: 14900`.
Both are wrong now. Henry has set the real App Store prices to:

- monthly **A$14.99** → `monthlyPriceAud: 1499`
- annual — see AGENT BRIEF; if the brief does not give you a number, leave the
  annual value alone and say so in your report rather than inventing a price.

Both products carry a **14-day free trial** as an App Store introductory offer.
`app/paywall.tsx` already documents this and `lib/iap.ts:ProOffering.trialDays`
already refuses to claim a trial the store has not reported — do not hardcode
"14 days free" anywhere.

## House rules (all agents)

- **Do not run any git write command.** No commit, no push, no branch, no stash.
  Edit files only. The orchestrator commits.
- Match the surrounding code's voice. This codebase explains **why**, in prose,
  above the thing it is explaining. A comment that restates the code is noise;
  a comment that records the attack it prevents is the point.
- Add real tests. `node:test` in `clippar_app/tests/` for app code; Deno tests
  next to the function for edge code.
- Verify before you claim. Baseline on this branch:
  ```
  cd /Users/hendacow/projects/clippar-codes/clippar_app && npx tsc --noEmit && npm test
  ```
  and for edge functions:
  ```
  cd /Users/hendacow/projects/clippar-codes/clippar_app/supabase/functions && deno test --allow-env --no-check=remote --node-modules-dir=none <path>
  ```
  Paste the real tail of the real run in your report. A green run you did not
  actually run is the worst possible outcome — the entire point is evidence.
