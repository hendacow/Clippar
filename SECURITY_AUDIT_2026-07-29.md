# Clippar security hardening — 29 July 2026

Branch `security/hardening-2026-07-29`, cut from `origin/main` @ 57c865d.
Worked against the *Clippar Mobile App Security, Performance and Scalability
Engineering Specification* v1.0.

**Status: all seven fix groups run and reviewed. Read "Still open" and "Yours" before
treating anything as closed — several items need a deploy or a rotation to take effect.**

---

## What was run

| Phase | Agents | Outcome |
|---|---|---|
| Red team | 8 hunters + 8 adversarial verifiers | 65 filed → **54 confirmed**, 11 refuted, 75 items ruled not-applicable |
| Refactor scout | 5 scouts + 5 behaviour gates | 75 suggestions → **39 cleared** (~7,470 lines), 36 blocked |
| Implementation, round 1 | 7 implementers + 7 reviewers | **all 7 killed by a session usage limit mid-run**; partial edits recovered and finished by hand |
| Implementation, round 2 | 4 implementers + 4 reviewers | 22 fixes, **18 upheld, 4 sent back**, 16 scoped out |

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
- `get-shared-reel` has no JWT so it keys on IP. **This described taking the last
  `X-Forwarded-For` entry, which is no longer what the code does** — a later
  deployment measurement showed Supabase's gateway *overwrites* the header rather
  than appending, so the last entry was Supabase's own load balancer and the first
  is the gateway-asserted client. `clientIp()` now prefers `cf-connecting-ip` and
  falls back to entry `[0]`; see its comment for the measurement. Corrected
  2026-08-26 — the original reasoning was sound in general and wrong here.
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
| App tests | 151 | **237** |
| Edge-function tests | **0 running** | **74** |
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

## Round two — the four groups that were killed

All four ran and were adversarially reviewed. **22 fixes, 18 upheld, 4 sent back,
16 correctly scoped out.**

- **Edge/web/CI** — `search-courses` moves the GolfCourseAPI key server-side;
  `create-share-link` drops its unversioned `deno.land` import (that import
  resolved the RNG minting share tokens, the only secret protecting a shared
  reel); `process-round` stops blocking 840s on Modal — past the platform
  wall-clock limit, so the AbortController never fired and rounds wedged at
  `processing` holding a claim the user cannot clear; `sync-courses` encodes
  `country` (it was appending attacker-chosen params to a URL carrying our paid
  key); a project-wide 100/hr GPU ceiling; secret scanning wired into CI with the
  path filter removed.
- **Capture** — clicker presses under the tutorial scrim no longer start a real
  recording that then gets silently unlinked; GPS out of the logs; permissions no
  longer requested on tab mount.
- **Auth** — `local_rounds` scoped by `user_id`, fail-closed.
- **Media** — `excludeFromBackup` implemented natively (`isExcludedFromBackup` +
  `FileProtectionType.completeUnlessOpen`).

### What I fixed by hand after reading the reviews

The reviewers rejected four fixes. Every rejection was correct — each had done
real work and left the half that mattered:

1. **A data-loss regression.** `clearLocalDatabase` was still an unqualified
   `DELETE` across every table plus `deleteFile()` on every clip URI, so on a
   shared phone user A deleting *their* account destroyed user B's rounds and raw
   video. Now scoped through `local_rounds.user_id`, fail-closed.
2. **`useShutter`'s `armed` option had no call site** — the same
   defined-but-never-called failure as the Modal auth helper. It defaults to
   `true`, so the gate existed and was never applied.
3. **Actions pinning covered two of six workflows.** `build.yml` still had a
   floating `expo/expo-github-action@v8` holding `EXPO_TOKEN` — code execution
   there buys an OTA push to every App Store install.
4. **The API key was still in the bundle** despite the proxy, because
   `constants/config.ts` still read it and Expo inlines those as literals. Also
   scrubbed from both tracked `.env.*.example` files.
5. **The proxy had made the DoS cheaper** — the shared upstream budget was spent
   before validation, so junk requests burned it.
6. **Backup exclusion covered `clips/` and left the sharper data** — the SQLite
   DB carries per-shot GPS, and `exports/` holds full-fidelity shared clips.
7. **Account deletion's recent-auth gate was client-only** — a stolen token still
   deleted the account by curl. Now enforced server-side on the token's `iat`.

## Still open

- **`stripe-webhook` still echoes `err.message`** to the caller (one of five
  handlers; the other four are fixed). Shop is hidden at v1 and the function is
  undeployed.
- **Clip-level local scoping.** Rounds are scoped; individual clip queries reach
  them through an already-scoped round id, which the reviewer judged sufficient.
- **`resetToStart` still unlinks real clips with no undo entry** —
  `hooks/useRound.ts` was outside every group's allowlist.
- **Sentry breadcrumbs.** GPS no longer reaches the log, but `Sentry.init` still
  has no `beforeBreadcrumb` and no `maxBreadcrumbs`.
- **The temp-export sweep in the wipe path is unscoped** — it can delete another
  account's cached trims. Cache only; source footage is untouched.
- **No test for the delete-account freshness check** (the handler is not exported).

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
5. Still open from the July 23 audit: rotate the exposed Resend key (the document
   holding it is identified in the private notification to Henry, not here — this
   file is on a public repo and the key is not yet rotated), delete the stray
   committed VS Code extension (path in the same private notification), EAS Update
   code signing, Vercel firewall/CAPTCHA on the waitlist form.

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

---

## DEPLOYED — 29 July 2026

Everything below was applied and then verified against the live system, not
assumed.

**Production Supabase** (`xdefwnqyjffgclzqmvax`)
- Migrations **016 + 017 applied**. Dev got them first and was verified there.
- Edge functions deployed: get-shared-reel, create-share-link,
  create-payment-intent, delete-account, apple-link, sync-courses,
  revenuecat-webhook, search-courses.
- Secrets set on dev AND prod: `GOLF_COURSE_API_KEY` (new key, confirmed
  different from the leaked one), `CLIPPAR_PIPELINE_SECRET`.
- **Rate limiter verified on production**: 1 sanity call + 130 probes against the
  120/hour cap gave 119 × 404 then **11 × 429** — exactly the configured ceiling.

**Modal** (`clippar-shot-detector`)
- `clippar-pipeline-auth` secret created; `pipeline_secrets` now actually
  attached to both endpoints (it was defined and never referenced).
- Verified live: no secret → `unauthorized`, wrong secret → `unauthorized`,
  correct secret → passes auth. Both endpoints.
- Gotcha worth keeping: a **warm container served the previous build through two
  ordinary `modal deploy` runs**. It took `modal app stop` + deploy to actually
  replace it. Don't trust a deploy alone when verifying a security change here.

**One thing that only surfaced by testing** — the authenticated Modal call fails
resolving `bcxgoloehditjgcvfsho.supabase.co`. That is neither prod nor dev: the
Modal `supabase-credentials` secret points at a Supabase project that no longer
exists, so this pipeline could not have worked even when called. Consistent with
`lib/pipeline.ts` having no call sites in the shipping app.

### Not a security finding, but the biggest user-visible bug found
`getGolfCourseDetailLive` returned **null on every call** because `tees` is an
object keyed by gender and the code iterated it as an array — the TypeError was
swallowed by a catch. So the app never once read live hole data, and every hole
fell through to a par-4 default. On a par-72 course that is wrong for roughly
eight holes, and the wrong number is burned into the exported reel.

Verified against the live API, fixed, and covered by 7 tests built from the
captured real payload. Also: `UPSTREAM_BUDGET` was 250/day against a free tier
that is actually **50/day** (their pricing page), so the guard could never have
fired before the vendor's own limit.

### Resend
Zero references in the repo — the only matches were Sentry's `beforeSend`. It was
never wired in; the waitlist uses Sender.net. Nothing to remove in code.
