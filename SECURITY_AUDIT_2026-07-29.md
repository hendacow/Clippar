# Clippar security hardening — 29 July 2026

Branch `security/hardening-2026-07-29`, cut from `origin/main` @ 57c865d.
Worked against the *Clippar Mobile App Security, Performance and Scalability
Engineering Specification* v1.0.

**Status: partial. Read the "Not done" section before treating anything as closed.**

---

## What was run

| Phase | Agents | Outcome |
|---|---|---|
| Red team | 8 hunters + 8 adversarial verifiers | 65 filed → **54 confirmed**, 11 refuted, 75 items ruled not-applicable |
| Refactor scout | 5 scouts + 5 behaviour gates | 75 suggestions → **39 cleared** (~7,470 lines), 36 blocked |
| Implementation | 7 file-disjoint implementers + 7 reviewers | **all 7 killed by a session usage limit mid-run**; partial edits recovered and finished by hand |

The implementation fan-out died before any reviewer ran. Everything that survived
was reviewed manually instead, and two fixes that had been left in a
"looks done, isn't" state were completed. Those are called out below because they
are the most dangerous kind of finding: a control that reads as present.

Confirmed findings by severity: **7 high, 20 medium, 27 low.** 50 code-owned, 4 yours.

---

## Fixed and verified

### Rate limiting (the original ask) — `65f07e1`
Only two endpoints had caps, and both counted with read-then-write:
`SELECT` the count, compare, `UPDATE count+1`. `enforceDailySyncCap`'s own comment
conceded the race and called the overshoot acceptable. It is not: fire 200
requests concurrently, every one reads the same pre-increment value, every one
passes, and 20-a-day is not a limit. The other seven functions had nothing.

- Migration 016 — `consume_rate_limit()` makes the increment and the read one
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent callers serialise
  on the row lock. Service-role only; a user can neither read their counter nor
  reset it.
- All nine endpoints now covered, limits in one reviewable table.
- `get-shared-reel` has no JWT so it keys on IP — taking the **last**
  `X-Forwarded-For` entry. The leftmost is caller-supplied; reading `[0]` would
  hand out a fresh bucket per request and limit nothing. Tested explicitly.
- `create-payment-intent` fails **closed** (every call spends Stripe quota on your
  credentials). Everything else fails open — a limiter outage must not take the
  product down.

### The signing oracle — `15aedf0` (worst finding)
`get-shared-reel` called `createSignedUrl(round.reel_url)` with the **service
role**, which bypasses storage RLS entirely. Migration 013 grants `authenticated`
write access to `reel_url`, and reels live at the predictable
`reels/<roundId>.mp4`. So:

1. create a throwaway round of your own
2. `PATCH rounds SET reel_url='reels/<victimRoundId>.mp4', is_published=true`
3. `create-share-link` for your **own** round — the ownership check passes honestly
4. `GET get-shared-reel` with your own token

→ a playable signed URL to another golfer's private reel. The same trick reached
raw per-hole clips. It survived unpublish, revocation and deletion, because the
round UUID is printed inside every signed URL the endpoint returns, so anyone who
had ever opened one of that user's share links held a permanent capability.

Found independently by two agents on different surfaces; chain traced by hand
before fixing. The key is now **derived from the round id**, so `reel_url` cannot
influence what gets signed.

### RevenueCat TRANSFER — `15ced12`
TRANSFER was ack-and-skipped, on the reasoning that acting on it risked revoking a
payer whose id appears in `transferred_from`. The cost was that nothing ever took
Pro off the **old** identity: buy once, sign into a second account, both keep Pro,
repeat indefinitely. Now revokes the source and grants the target in one event,
with the over-revocation worry handled head-on — an id on **both** sides (alias
merge) is never revoked, and the target is granted only when the expiry is still
in the future. Refunds arrive from Apple as a `CANCELLATION` with a reason, not
their own type, so those now end access immediately instead of leaving a refunded
subscriber active for the period they were paid back for.

**22 Deno tests, written by hand** — the agent exported `deriveUpdates` to make it
testable and was killed before writing any.

### Shutter admission control — `15ced12`
The clicker is an HID keyboard: unidentifiable, and it autorepeats. A second
shutter left on in a golf bag flooded the gesture resolver, and because every
event re-armed the click-flush timer the golfer's own press could never resolve —
the camera stopped responding — while the tail of the flood landed as a 3-click
penalty written to SQLite. Debounce existed; the rate limit did not (spec BLE-002).

**14 tests, written by hand.** Most assert the *opposite* of the security
property: that a double-click, a triple-click and 40 presses across a full round
all still get through. A dropped press loses a shot that cannot be re-recorded.

### Modal GPU pipeline — `7fcab6b` (two fixes that only *looked* done)
1. **The auth gate was never wired in.** `_pipeline_secret_ok()` was written,
   documented and committed, and nothing called it — grep found exactly one
   reference, its own definition. Both endpoints were still wide open. Now the
   first statement of each body, before any import or allocation: the function is
   `gpu="T4", memory=16384, timeout=900`, so one unauthorised POST buys fifteen
   minutes of GPU on your account.
2. **SSRF and key exfiltration were untouched.** Both endpoints still preferred
   `supabase_url`/`supabase_key` from the request body. Two bugs in one line: the
   URL is interpolated into the storage calls, and the key travels as a Bearer
   header *to whatever host that URL names* — so supplying your own URL while
   omitting the key made the container post your **service-role key** to the
   attacker's server. Both now read from the container's own Modal secret.

`process-round` updated to match: sends the shared secret, and no longer sends the
service-role key over the network at all.

### Migration 017 — authz hardening
Clips upload owner-scoping + per-user quota, `hardware_orders` INSERT/UPDATE/DELETE
revoked from clients (they could forge a `status='paid'` order), and insert caps on
`rounds`, `shots` and `courses` enforced by trigger.

### Also landed
Keychain moved to `…ThisDeviceOnly` with a one-time migration (the default is
included in encrypted backups and restores onto a *different* device, making the
refresh token portable); Google OAuth moved to PKCE; `iap.reset()` finally called
on sign-out; ShareSheet upload consent; privacy manifest; `stripe-webhook` column
fix; error-message leakage in two functions.

---

## Test and build evidence

| Gate | Before | After |
|---|---|---|
| App tests | 151 | **192** |
| Edge-function tests | **0 running** | **55** |
| Typecheck | clean | clean |
| Release simulator build | — | **builds, launches, renders** |

Two bugs in my own gate script, found and fixed:
- it ran only `supabase/functions/_shared/`, so it reported green while
  `delete-account/index.test.ts` was erroring out entirely
- that file has been **unrunnable since PR #66** — importing the module builds a
  service-role client at top level and `createClient` throws on an undefined URL,
  so its 10 tests never once executed

`scripts/verify-security-branch.sh` — logic gate.
`scripts/verify-simulator.sh` — build, launch, screenshot gate.

---

## NOT DONE — do not treat these as closed

Four of seven implementation groups never ran. Outstanding confirmed findings:

**Edge functions / web / CI** (11 findings, group never started)
- `sync-courses`: `escapeLikePattern` misses `*`, which PostgREST converts to `%`
- `sync-courses`: user-supplied `country` interpolated into a third-party URL unencoded
- `create-payment-intent`: product allowlist is a bare object lookup, so inherited
  `Object.prototype` keys pass the "unknown product" check
- `create-share-link`: still imports an **unversioned** `deno.land/std` module
- `clippar-web/api/submit.py`: public waitlist endpoint, no rate limit — each call
  opens a Neon connection and creates a Sender.net subscriber with an attacker-chosen email
- GitHub Actions pinned to mutable tags in workflows holding the EAS release token
- No secret scanning in CI; `.gitignore` misses some dotenv filenames Expo loads
- `preview` EAS profile carries the production bundle id and production Supabase
- `process-round` blocks up to 840s on Modal inside the request

**Capture** (partially done — `useShutter` fixed, rest untouched)
- Clicker starts a **real** recording under the blocking tutorial scrim, and the
  clip is then silently deleted
- Precise GPS `console.log`'d per clip → shipped to Sentry via console breadcrumbs
- Camera/mic permission requested on Record tab mount, before the user chooses capture
- CoreBluetooth central manager instantiated at module import

**Auth/session** (partially done — Keychain + PKCE fixed)
- Sign-out leaves the previous user's rounds and video in local SQLite; the local
  DB has no user column. **Deliberately not fixed**: this app holds the only copy
  of a golfer's footage, and wiping on sign-out destroys a round that cannot be
  re-recorded. Needs scoping rows to a user id plus an explicit "remove local
  media" action, not a wipe bolted onto sign-out.
- Account deletion has no recent-auth requirement (the comment calling
  `refreshSession()` a "re-auth gate" is wrong)
- Account deletion leaves raw video on disk

**Media**
- `excludeFromBackup` has **no native Swift implementation**. The TS wrapper
  reports failure honestly rather than pretending, but MEDIA-002 (backup
  exclusion + Data Protection class on raw clips) is still open.
- `reclaimTemporaryExports` is written and tested but has **no call site**.

---

## Yours — I can't do these

1. **Rotate the GolfCourseAPI key.** It is committed to a **public** repo and
   compiled into the App Store binary. Rotating alone is not enough; it needs to
   move behind an edge function with a server-held key.
2. **`CLIPPAR_PIPELINE_SECRET`** — the Modal fix is inert until you add it to the
   Modal secret `supabase-credentials` *and* set the same value on the
   `process-round` edge function. Until both exist the gate rejects everything,
   including us. That is the correct failure direction, but it is not deployed.
3. **Migration 016 and 017 are unverified.** No Docker or Postgres on this
   machine, so the SQL has never been executed. Apply to **dev** first.
4. **Migration number collision** — `perf/rls-initplan-and-indexes` also has a
   `016_`. Whichever branch merges second must renumber.
5. Still open from the July 23 audit: rotate the Resend key in `Mailing key.docx`,
   delete `clippar_app/kickbacks.vsix`, EAS Update code signing, Vercel
   firewall/CAPTCHA on the waitlist form.

---

## Refactor — cleared but NOT applied

39 suggestions (~7,470 lines) were cleared as behaviour-preserving by the gate
reviewer. **None have been applied** — the security work took priority and mixing
7,000 lines of deletion into a security branch would make it unreviewable.

Biggest: four unreferenced components (1,923 lines), `ScoreCollection.tsx` (907),
seven never-imported UI components (750), `StatsHero.tsx` (494), the legacy
`Scorecard.tsx` (408), `OnboardingIntro.tsx` (403).

The gate **blocked** 36, including deleting the Shop tab and the detection-strategy
variants — reachable by file path or config rather than by import, which a grep
alone would have called dead.
