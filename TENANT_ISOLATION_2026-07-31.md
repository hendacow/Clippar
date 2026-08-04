# Tenant isolation audit — 2026-07-31

**Question:** can a signed-in Clippar user read, modify or delete another user's data?

**Answer:** yes, in three ways, plus one path to a free lifetime Pro entitlement.
All four are closed by `clippar_app/supabase/migrations/019_tenant_isolation.sql`.
Six further items are reported below but deliberately **not** changed — three
because they are not my files, three because the fix costs more than the bug.

Attacker model used throughout: an ordinary signed-up user with the shipped anon
key (recoverable from any IPA, publishable by design), a valid JWT for their own
account, and curl. No client patching. PostgREST and the Storage REST API are
called directly, so nothing in `lib/` is in the path and no edge function — and
therefore no `_shared/rateLimit.ts` counter — can observe any of it.

Scope reviewed: migrations 001–018, all eleven edge functions plus `_shared`,
every `supabase.from(...)` and `supabase.storage.from(...)` call site in
`lib/`, `hooks/`, `app/`, `components/`.

---

## Findings, ranked by what an attacker actually gets

### 1. Free lifetime Pro, by inserting your own profile row — P0

**Where:** `001_initial_schema.sql:27` (policy), and the table-wide INSERT grant
that `013_security_hardening_rls.sql` never revoked.

013 revoked the blanket **UPDATE** grant on `profiles` and re-granted a column
list, precisely because RLS cannot express column-level write rules and
`subscription_status` is what `lib/subscription.ts:107-113` reads as proof of
Pro. It left **INSERT** alone. The INSERT policy is
`WITH CHECK (auth.uid() = id)` — that constrains *which row*, never *which
columns*.

```bash
curl -X POST "$SUPABASE_URL/rest/v1/profiles" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MY_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"id":"<my own uid>","email":"me@example.com",
       "subscription_status":"active","subscription_expires_at":null}'
```

`status='active'` with a NULL expiry is read as **lifetime** by
`lib/subscription.ts:110-111` and by `public.has_active_pro()`
(`017:81-87`), which is also the predicate gating the Pro branch of the clips
storage INSERT policy. One request, no purchase, no RevenueCat event, permanent,
and invisible to the webhook that is supposed to be authoritative.

The `CODES_CONTRACT.md` line "If you find any path that lets a signed-in client
write `subscription_status`, that is a P0 finding — report it loudly" is exactly
this path. Note it also breaks the redemption-code feature's premise: the
entitlement 018 is careful to make service-role-only is settable by the client
through a different door.

**Reachability.** The insert only lands when the row is absent, and normally the
`handle_new_user` trigger has already created it. Two ways it is absent:

* `handle_new_user` (`001:44-46`) swallows every exception and returns NEW, so a
  failed signup insert is silent. `lib/api.ts:44-58` exists specifically to
  repair that case, which is evidence it happens in production.
* `delete-account` deletes `profiles` (`index.ts:211`) **before**
  `auth.admin.deleteUser` (`index.ts:213`). If that last call fails the handler
  throws a 500 — and the caller still holds a live one-hour session for an
  account whose profile row is now gone. Self-service, repeatable.

"The row usually exists" is not an authorisation control.

**Fixed** — 019 §1. Mirrors 013: `REVOKE INSERT`, re-`GRANT INSERT` on the
non-privileged columns. Verified against `lib/api.ts getProfile()` (`44-58`),
the only client INSERT into `profiles` anywhere in the app; it sends
`{id, email, display_name}`, all three granted. `RETURNING *` still works —
013 never touched the SELECT grant. `handle_new_user` is SECURITY DEFINER and
runs as the function owner, so signup is unaffected.

---

### 2. Writing rows into another user's round — P1, and it can destroy a round in progress

**Where:** `001_initial_schema.sql:182-184`.

```sql
CREATE POLICY "Users can manage own shots" ON shots FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

The policy binds `auth.uid()` to `shots.user_id` and says nothing about
`shots.round_id`. A shot row only has to *claim* to be yours; it may point at
anybody's round.

```bash
curl -X POST "$SUPABASE_URL/rest/v1/shots" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MY_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"<my own uid>","round_id":"<victim round uuid>",
       "hole_number":1,"shot_number":1,"clip_url":"anything"}'
```

`scores` got this right in the same migration (`001:156-158` joins to `rounds`
and checks `rounds.user_id`). `shots` simply did not.

What it buys:

* **Destroying a round mid-recording.** `017:324-352` caps a round at 300 shots,
  and the cap counts *every* row for that `round_id`, not just the caller's. 300
  planted rows and the owner's next legitimate insert raises `check_violation` —
  on a golf course, for footage that cannot be re-recorded. The cap was added to
  bound abuse; this turns it into the weapon.
* **Feeding the composer.** `process-round` dispatches Modal, which reads the
  round back with the **service role** and therefore does not see shots RLS at
  all. Rows the owner cannot see in their own editor (their client reads are
  filtered to `auth.uid() = user_id`) are still visible to the pipeline.

**On knowing the victim's round id.** It is not secret the way a UUID normally
is: it is the object key inside every signed reel URL the share flow hands out —
`…/object/sign/clips/reels/<roundId>.mp4`, minted at
`get-shared-reel/index.ts:157`. Anyone ever sent a share link holds one. (See
finding 7: share links are currently dead, which suppresses this today.)

**Fixed** — 019 §2. Adds the round-ownership join to WITH CHECK, keeping the
`user_id` binding. USING is unchanged — an attacker could never UPDATE or DELETE
a victim's shot row anyway, since those carry the victim's `user_id`.

Verified against both `createShot` callers: `lib/uploadQueue.ts:178-190` does an
RLS-scoped `rounds` lookup and throws *before* any shot write (so "found"
already means "owned"), and `app/round/import.tsx:706-712` passes the id
returned by `createRound`. The `local_…` fallback that used to produce orphan
shot writes was removed (`hooks/useRound.ts:157`) and `uploadQueue.ts:166-172`
still rejects those ids. There is no path that writes a shot before its round
row exists, so this cannot fire on a real round.

---

### 3. `clips` storage: a latent bucket-wide read, an unowned UPDATE destination, and an owner locked out of their own reel — P2

**Where:** `011_clips_storage_owner_scope.sql:28-69`. 017 rewrote INSERT and left
SELECT/UPDATE/DELETE as 011 wrote them. Three distinct problems.

**3a — the latent read.** The SELECT policy grants any authenticated user read
on clips of a round where `share_token IS NOT NULL AND is_published = TRUE`.

That branch is inert today, for a reason nobody wrote down: a policy expression
re-enters the referenced table's own RLS (this is the same fact 017 relied on
when it made `has_active_pro()` SECURITY DEFINER — `017:62-66`), and `013:64`
dropped the only policy that ever exposed a stranger's `rounds` row. So the
subquery cannot see a victim's round and the branch never matches.

It is one line from matching again. `is_published` is **never written by any
code in this repo** (finding 7), so every share link 404s — and the
shortest-looking fix for that is to restore the public `rounds` SELECT policy
013 removed. The moment someone does, this branch wakes up and every **raw
per-hole clip** of every published round — the Pro cloud-backup footage, not the
reel — becomes readable *and enumerable* by any signed-in stranger:

```js
await supabase.storage.from('clips').list('')           // → published round ids
await supabase.storage.from('clips').list(victimRound)  // → their raw clips
await supabase.storage.from('clips').createSignedUrl(`${victimRound}/${f}`, 3600)
```

It also serves nothing. Reels live at `reels/<roundId>.mp4`, whose
`foldername[1]` is the literal `'reels'` and never a round uuid, so the branch
has never applied to the thing that is actually shared; and the public viewer at
clippargolf.com is **anonymous**, reaching reels only through `get-shared-reel`,
which runs as the service role and bypasses storage RLS entirely. No app or web
code reads another user's clips as `authenticated` (grepped: no consumer of
`share_token`/`is_published` exists outside the edge function).

**3b — UPDATE's WITH CHECK was `bucket_id = 'clips'`.** It constrains the bucket
and not the destination key. Storage's move/copy operations are an UPDATE of
`storage.objects`, so the owner of round A could rename an object *into* round
B's folder. `lib/api.ts:1136-1147 getFirstClipSignedUrl` renders whichever
object sorts first in `clips/<roundId>/` on the victim's home screen — a planted
object plays as the victim's round. (Nothing in the app calls `.move()`/
`.copy()`, so tightening costs nothing; an upsert onto an existing key keeps the
same name and still passes.)

**3c — the owner cannot reach their own reel.** 017 added
`reels/<roundId>.mp4` to the INSERT policy, but SELECT/UPDATE/DELETE still only
understand the `<roundId>/<file>` shape. So for the reel keyspace the owner
cannot SELECT (`lib/resolveReelSource.ts:112` signs `clips/reels/…` and gets
nothing — the cloud reel preview is dead), cannot UPDATE (`lib/r2.ts:172`
uploads with `x-upsert: true`, which is an UPDATE once the key exists, so
re-composing and re-uploading a reel 403s), and cannot DELETE. This is a
security problem and not only a bug, because the visible symptom is "reels don't
work" and the obvious cure is to widen the policy back to `bucket_id = 'clips'`,
which is exactly what 011 was written to undo.

**Fixed** — 019 §4. All three policies rewritten: own-round clips **or** own
round's reel, no stranger branch, and UPDATE's WITH CHECK made identical to its
USING. Verified against `getSignedClipUrls` (`api.ts:946-963`),
`getFirstClipSignedUrl` (`1136-1147`), `r2.ts getClipUrl` (`380-397`) and
`uploadReelToStorage` (`351-370`), `resolveReelSource.ts:105-115`,
`sharing.ts ensureReelUploaded` (`157-188`), `api.ts deleteRound` (`150-173`),
`uploadQueue.ts uploadRoundClips` — every one addresses `<ownRoundId>/<file>` or
`reels/<ownRoundId>.mp4`, both permitted. `delete-account` (`150-168`) is
service-role and never consults these policies.

---

### 4. The `clips` bucket's `public` flag is not enforced by any migration — P3

`008_clips_storage_bucket.sql:11-21` creates the bucket with `public = false`,
but its `ON CONFLICT` clause only refreshes `file_size_limit` and
`allowed_mime_types`. If the prod bucket was created from the dashboard with the
public toggle on, re-running 008 never turned it off — and a public bucket
serves `/object/public/clips/<key>` to anyone with the URL, **no credential at
all**, making every policy above decoration. The keys are `<roundId>/…` and
`reels/<roundId>.mp4`.

I cannot see prod, so I cannot say whether this is live. **Fixed defensively** —
019 §4d forces `public = false`. Safe either way: every read path in the app
mints a signed URL (which works on a private bucket), `get-shared-reel` signs
server-side, and `resolveReelSource.ts:97-104` already re-signs a legacy
`/object/public/clips/…` value.

---

### 5. `rounds.dispatch_claimed_at` is client-settable at INSERT — P4, no live exploit

013 excluded the column from the UPDATE grant so a client cannot re-arm the
process-round claim in a loop against a ~14-minute Modal GPU job. The INSERT
grant was never touched, so the invariant holds for the second write of a row
and not the first.

Nothing exploitable falls out today: `process-round`'s claim (`index.ts:184-189`)
treats a stale stamp as re-claimable, so a forged value only costs the forger
their own dispatch, and the daily counter (`index.ts:154-158`) counts rows at or
after midnight — planting can only *increase* it. Recorded because the point of
a service-role-only column is that a client cannot choose its value.

**Fixed** — 019 §3, as a `BEFORE INSERT` trigger that **nulls** the value rather
than a column-list grant that would refuse the row. Deliberate: `rounds` gains
columns (015 had to hand-patch 013's UPDATE grant for `start_hole`), and a
column missing from an INSERT grant fails round *creation* — the first step of
recording. A normalising trigger never refuses a row and needs no maintenance.
Same pattern as `017:380-402` for `courses.submitted_by`. Verified against
`lib/api.ts createRound` (`121-133`), the only client `rounds` INSERT, which has
never set the column — so this is a no-op on every real round.

---

### 6. `public.seed_course` is exposed as an unvalidated 12-argument RPC — P5

`003:50-124` defines it for that migration's seed data and never revokes
EXECUTE, so it defaults to PUBLIC — and PostgREST publishes every `public`
function at `/rest/v1/rpc/<name>`. Any caller can drive a course insert plus
eighteen `holes` upserts, no argument validated, in one request.

It is SECURITY INVOKER, which is the only reason it is not an escalation: RLS
applies to the caller, 013 removed the UPDATE policies on `courses`/`holes` so
the update branches match nothing, and 017's insert caps still meter it because
`auth.uid()` is intact inside an invoker function. What remains is a large RPC
surface that exists for one migration's benefit and that nothing calls at
runtime.

**Fixed** — 019 §5 revokes EXECUTE from PUBLIC/anon/authenticated. `seed_course(`
appears only in migrations 003 and 004, which run as the migration role.

---

## Reported, not changed

### 7. Every share link is dead — `is_published` is never written (functional, and it is the trigger for finding 3a)

`rounds.is_published` defaults to FALSE (`001:122`). Grepping the entire repo:
**nothing** writes it — not `create-share-link` (which mints and stores only
`share_token`, `index.ts:93-96`), not the app, not the Modal pipeline. But
`get-shared-reel/index.ts:126` refuses on `round.is_published !== true`. So 100%
of share links return "This reel isn't available."

Not my file to change, and it is a product decision whether `create-share-link`
should set `is_published` or `get-shared-reel` should stop requiring it. Flagging
it here because **the tempting fix is the dangerous one**: restoring the
"Shared rounds are publicly viewable" RLS policy that `013:64` deliberately
dropped would re-enable bulk harvesting of every user's share tokens and reel
URLs over the anon key, *and* re-arm finding 3a. The right fix is one line in
`create-share-link` (set `is_published: true` alongside the token), not a policy.

### 8. `delete-account` ordering leaves a live session with no profile row

`index.ts:211` deletes `profiles`, then `index.ts:213` deletes the auth user and
throws on a real failure. In between, the caller holds a working access token for
an account with no profile row — the reachability window for finding 1. Once 019
§1 lands, the worst outcome is a user who can re-create a normal profile, which
is harmless. Suggest deleting the auth user first (the profile cascades) or
tolerating a partial state explicitly. Not my file.

### 9. `delete-account` never deletes the composed reel

`index.ts:156-168` lists `clips/<roundId>` and `reels/<roundId>` for each round.
The reel actually lives at `clips/reels/<roundId>.mp4` (`r2.ts:351`,
`get-shared-reel:157`) — not under `<roundId>/` and not in a bucket called
`reels`. So every deleted account leaves its reels behind as billable storage.
The `rounds` rows are gone, so nothing can sign them any more and it is not a
disclosure — just orphaned bytes and an incomplete erasure claim. One-line fix:
`remove([\`reels/${round.id}.mp4\`])`. Not my file.

### 10. Three storage buckets have no migration and no reviewable policies

`clips` is the only bucket any migration creates or polices. The app also
addresses:

| bucket | call site | key shape |
|---|---|---|
| `avatars` | `app/profile/edit.tsx:96-113` | `<userId>/avatar.<ext>`, `upsert: true`, read via `getPublicUrl` |
| `music` | `lib/music.ts:78-82` | `music/<trackId>.m4a` |
| `reels` | `lib/api.ts:1116`, `lib/resolveReelSource.ts:112` | legacy fallback |

Whatever policies these have were made in the dashboard and are invisible to code
review. **`avatars` is the one that matters**: the key is fully predictable from
a user id, the client uploads with `upsert: true`, so a bucket-wide
INSERT/UPDATE policy there means one user can overwrite another user's avatar
with arbitrary content of their choosing.

I could not fix this blind, and adding policies would make it *worse*: multiple
permissive policies are OR'd, so a new policy can only widen access, never
narrow it. Tightening requires knowing the names of what is already there.
019 §6 therefore prints them at deploy time. If you would rather not wait for the
migration, run:

```sql
SELECT id, public, file_size_limit FROM storage.buckets ORDER BY id;

SELECT polname,
       pg_get_expr(polqual, polrelid)      AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy WHERE polrelid = 'storage.objects'::regclass ORDER BY polname;
```

Anything whose expression is just `bucket_id = '<name>'` with no owner join is
bucket-wide for every authenticated user — the exact bug class 011 was written
to fix for `clips`.

### 11. `admin_users` RLS is infinitely recursive

`001:286-289` policies `admin_users` with a subquery **on `admin_users`**.
Postgres raises "infinite recursion detected in policy for relation
admin_users" on any client access, so the table is unreachable from the anon and
authenticated keys. That is fail-*closed*, which is why I left it: the only
consumer is `sync-courses isAdminUser` (`index.ts:33-53`), which uses the service
role and bypasses RLS entirely. Adding a self-read policy would let any user
learn whether they are an admin for no gain.

### 12. `rounds` UPDATE grant includes `id`, `user_id`, `created_at` — deliberately left alone

`013:123-143`. It looks alarming and is not exploitable across tenants: the
`FOR ALL` policy's WITH CHECK re-evaluates `auth.uid() = user_id` on the **new**
row, so a round cannot be reassigned to another user, and setting `id` to a
victim's round id violates the primary key.

There is one real (self-inflicted) consequence: a user can rewrite their own
round's `id`, which orphans their storage objects out of both the `017`
`clips_quota_ok` count (`017:133-144`, which enumerates the user's *current*
round ids) and `delete-account`'s cleanup (`150-168`, same enumeration) — a
quota bypass and a way to leave undeletable bytes.

Not fixed on purpose. The fix is another column-list churn on `rounds`, and 015
already had to patch 013 for exactly that: a column that falls outside the list
403s the client. Weighed against a self-harm-only storage-cost bug, the risk of
403ing a paying user mid-round is the larger loss.

---

## Verified SAFE — the sweep, so you know it was exhaustive

**Tables (RLS state, policies, and grants each checked):**

| table | verdict |
|---|---|
| `profiles` | UPDATE column-scoped (013), SELECT/INSERT own-row. **INSERT was the hole (finding 1)**; fixed. No DELETE policy → deletion blocked. |
| `rounds` | Own-row FOR ALL, WITH CHECK re-checks `user_id`, so no transfer. Public SELECT dropped in 013. UPDATE column-scoped. Insert capped 50/day (017). See finding 12. |
| `scores` | Correct — joins to `rounds` and checks `rounds.user_id` on **both** USING and WITH CHECK. |
| `shots` | **Was the hole (finding 2)**; fixed. |
| `processing_jobs` | SELECT-own only; no INSERT/UPDATE/DELETE policy → RLS denies all client writes. |
| `hardware_orders` | SELECT-own only; INSERT policy dropped and INSERT/UPDATE/DELETE revoked in 017. |
| `daily_usage` | SELECT-own only; no write policy. |
| `course_presets` | SELECT/INSERT/UPDATE/DELETE all own-scoped. UPDATE omits WITH CHECK, which Postgres defaults to the USING expression, so `user_id` cannot be reassigned. Fine. |
| `courses` / `holes` | SELECT `TO authenticated`; UPDATE policies dropped in 013; INSERT open by design (`upsertCourseFromLiveApi` needs it) but capped and attributed in 017. No DELETE policy. Shared catalog, not tenant data. |
| `course_suggestions` | RLS on, INSERT/SELECT own-scoped, no UPDATE/DELETE policy. `status` is client-settable at insert, but nothing reads `status='approved'` to promote anything — `approve_suggestion` is admin-gated and looks up by id. Benign. |
| `music_tracks` | SELECT-only policy on `is_active`; no write policy. |
| `admin_users` | Recursive policy → fail-closed. See finding 11. |
| `apple_credentials` | RLS on, **zero policies** → service-role only. Correct for a table of Apple refresh tokens. |
| `sync_course_usage` | RLS on, zero policies → service-role only. |
| `api_rate_limit` | RLS on, zero policies, **and** `REVOKE ALL FROM anon, authenticated` (016:43). Belt and braces, correctly. |
| `redemption_codes` (018) | RLS on, `REVOKE ALL FROM anon, authenticated`, no policies. A code is unreadable and unmintable from any client key. |
| `user_entitlements` (018) | RLS on, `REVOKE ALL` then `GRANT SELECT` only, policy `USING (auth.uid() = user_id)`. Read-own, no client write. Correct. |

**SECURITY DEFINER functions — every one:**

| function | search_path pinned | EXECUTE | takes a caller-supplied user id? |
|---|---|---|---|
| `handle_new_user` | yes (010) | trigger-only (cannot be called directly) | no — reads `NEW` from `auth.users` |
| `touch_course_presets_updated_at` | yes (010) | trigger-only | no |
| `touch_apple_credentials_updated_at` | yes (`SET search_path = ''`) | trigger-only | no |
| `has_active_pro()` | yes | revoked from PUBLIC, granted authenticated + service_role | **no — reads `auth.uid()` internally.** Correct shape. |
| `clips_quota_ok()` | yes | revoked from PUBLIC, granted authenticated + service_role | no — `auth.uid()` internally |
| `consume_rate_limit` | yes | revoked from PUBLIC/anon/authenticated, **service_role only** | subject is opaque TEXT, but only the service role can call it |
| `sweep_rate_limits` | yes | service_role only | n/a |
| `enforce_rounds_insert_cap` / `enforce_shots_per_round_cap` / `enforce_courses_insert_cap` / `enforce_holes_insert_cap` | yes | trigger-only | no — `auth.uid()` internally |
| `redeem_code(TEXT, UUID)` (018) | yes | revoked from PUBLIC/anon/authenticated, **service_role only** | **yes, `p_user UUID`** — an impersonation primitive if reachable, but it is not: only the service role may execute it, and `redeem-code` derives the id from the verified JWT. Acceptable, and 018's own header calls this out. |
| `refund_rate_limit` (018) | yes | service_role only | n/a |
| `seed_course` | yes (010) | **was PUBLIC** — finding 6, now revoked | n/a (SECURITY INVOKER) |

**Edge functions — `verify_jwt`, subject derivation, service-role use, error leakage:**

| function | acting user from | verdict |
|---|---|---|
| `create-share-link` | verified JWT (`getUser(token)`) | Ownership re-checked with `.eq('user_id', user.id)`. `round_id` shape-validated against a UUID regex before it reaches a filter. Errors return a fixed string. **Safe.** |
| `get-shared-reel` | none — deliberately `--no-verify-jwt`, public viewer | Replaced by: a 128-bit share token, a uniform "not available" for missing/unpublished/no-reel (so it cannot be probed), IP rate limiting, and — the important one — the storage key is **derived from `round.id`, never from the client-writable `reel_url`** (`index.ts:155-157`). That is the reel_url signing-oracle from the 2026-07-29 audit, and it is genuinely closed. **Safe.** |
| `process-round` | verified JWT | `round.user_id !== user.id` → 404. The `.or()` filter interpolates only a server-computed timestamp, not user input. Claim is one atomic conditional UPDATE on a service-role-only column. Modal's status/body never relayed. **Safe.** |
| `delete-account` | verified JWT, **no user id accepted in the body** | Plus a server-side token-freshness check (`iat` ≤ 10 min), which is the control that survives a stolen token. **Safe** for isolation; see findings 8 and 9 for the ordering and cleanup bugs. |
| `apple-link` | verified JWT | `user_id` for the credential row comes from the JWT, never the body; `client_id` is read from the identity token's `aud` and allowlisted. **Safe.** |
| `create-payment-intent` | verified JWT | Price resolved from a server-side catalog; any client-supplied amount/currency ignored. Authenticates before parsing the body. **Safe.** |
| `stripe-webhook` | Stripe signature (`constructEvent`) | `user_id` comes from PaymentIntent metadata, which is server-set at `create-payment-intent` from the JWT. `kit_type` coerced to an allowlist. Signature-failure detail is logged, not returned. **Safe.** |
| `revenuecat-webhook` | shared secret, compared in constant time over SHA-256 digests | Identities must match a UUID regex; sandbox events skipped; a NULL expiry (= lifetime) requires an allowlisted non-consumable product id; TRANSFER revokes the source. **Safe.** |
| `search-courses` | JWT if present, else client IP | Reads and writes no user data. `query` length-bounded 2–80, `country` coerced to 2–3 letters, `course_id` to digits, and everything `encodeURIComponent`'d before it touches the upstream URL. Budget consumed *after* validation so junk cannot spend it. **Safe.** |
| `sync-courses` | verified JWT; `admin_users` checked for `sync_region` / `approve_suggestion` | ILIKE metacharacters escaped **and** re-verified with an exact-name check (`isExactNameMatch`) so a leaked wildcard misses instead of overwriting a shared course; `sync_single` is `insertOnly`; suggested hole data range-validated. **Safe.** |
| `_shared/rateLimit.ts` | n/a | `clientIp()` takes XFF entry `[0]` with a measured justification (Supabase's gateway overwrites rather than appends) — unusual, but documented and correct for this deployment. Fail-open by default, fail-closed where a call spends money. **Safe.** |

**Input handling specifically hunted for and not found:** no user-supplied value
reaches a `.or()`, `.filter()` or `.textSearch()` string anywhere (the one
`.or()` in `process-round` interpolates a server-computed timestamp); no user
value is interpolated into a storage path in any edge function (`get-shared-reel`
derives its key, `delete-account` uses ids it read back itself); no unbounded
array or string is accepted (`search-courses` bounds every field; `sync-courses`
bounds `name` at 120 chars); no database error, stack or upstream body is echoed
to a caller in any of the eleven functions.

**Round-recording path — nothing in 019 can break it.** Every change is either a
grant on a table the recording path does not write privileged columns of
(`profiles`), a WITH CHECK the recording path satisfies by construction
(`shots` — the round row provably exists first), a trigger that normalises
instead of refusing (`rounds`), or a storage policy that strictly *widens* what
the owner may do with their own reel while narrowing only what strangers may do.
No column list was added to any `rounds` grant, which is the one change shape
that has previously 403'd this app (015 patching 013).

---

## Verification

```
$ cd /Users/hendacow/projects/clippar-codes/clippar_app && npx tsc --noEmit
$ echo "EXIT: $?"
EXIT: 0
```

Clean, no output — same as the pre-change baseline. (019 adds no TypeScript;
this confirms nothing else in the tree regressed while the migration was
written.)

**Not run:** the migration itself. There is no local Postgres, Docker or
`psql` on this machine, so 019 has not been executed anywhere. Apply it to
**DEV first** and confirm, with two accounts:

1. Sign in as A, record and finish a round, upload clips (Pro account), compose
   and share a reel. All four must still work.
2. As B, attempt each attack above against A's round id — all four must fail.
3. Read the `[019] …` NOTICE output for the bucket/policy inventory (finding 10)
   before applying to prod.
