-- 018_redemption_codes.sql
-- Lifetime redemption codes: Henry prints a code, hands it to an ambassador,
-- they paste it once and hold Clippar Pro forever.
--
-- WHY THE PLAINTEXT CODE IS NEVER STORED
-- A redemption code is a bearer credential. It is worth a lifetime subscription
-- to whoever holds it, it is typed by a human, and it lives on a printed card
-- for months — so the threat is not "someone guesses one", it is "someone reads
-- one out of the database". Storing the code, or anything reversible to it,
-- means a single leaked backup / logged query / over-broad SELECT grant hands
-- out free Pro in bulk and there is no way to tell it happened.
--
-- WHY HMAC WITH AN OUT-OF-DATABASE PEPPER, AND NOT A PLAIN SHA-256
-- The codes are 16 characters of Crockford base32 — 80 bits, but from a KNOWN
-- alphabet in a KNOWN length. A plain SHA-256 of that is not a secret from
-- anyone holding the table: the attacker knows the exact input space, so a leak
-- of `code_hash` is a leak of the codes, minus a few GPU-seconds per code. The
-- hash is supposed to SURVIVE a database compromise; a bare digest does not.
--
-- So the digest is HMAC-SHA256(pepper, normalized_code) where `pepper` is a
-- Supabase Function secret (REDEMPTION_CODE_PEPPER) that exists only in the
-- edge runtime's environment and in Henry's generator shell. It is never a
-- column, never a migration constant, and never reaches Postgres — this
-- function is handed a hash that was already computed elsewhere. A DB-only
-- compromise therefore yields a list of opaque 32-byte values and nothing else.
--
-- WHY HMAC AND NOT BCRYPT / ARGON2
-- The usual answer for "hashing a secret humans type" is a slow KDF. It is the
-- wrong tool here, for two reasons:
--   1. Lookup shape. A KDF salts per row, so verification means "fetch every
--      row and test each one" — a full table scan per attempt, which is both
--      slow and a self-inflicted DoS. HMAC is deterministic, so verification is
--      a single indexed equality on a UNIQUE column: O(1), and the index is the
--      only thing the query planner ever needs.
--   2. What the cost factor would buy. A KDF's work factor exists to protect
--      LOW-entropy secrets (passwords people choose). These codes carry 80 bits
--      from a CSPRNG. Online guessing is already hopeless — see the arithmetic
--      in supabase/functions/redeem-code/limits.ts — and offline guessing is
--      already blocked by the pepper. Paying 100ms per verification would buy
--      nothing and cost every legitimate redemption.
--
-- Related: 016_api_rate_limit.sql (the atomic-counter idiom this file reuses),
-- 013_security_hardening_rls.sql (why billing columns are service-role only).

-- ─────────────────────────────────────────────────────────────────────────────
-- The codes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.redemption_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC-SHA256(REDEMPTION_CODE_PEPPER, normalize(code)), lowercase hex.
  -- UNIQUE because it is the lookup key AND because two codes colliding here
  -- would silently make one of them un-redeemable; the index is what makes
  -- verification a single probe rather than a scan.
  code_hash    TEXT        NOT NULL UNIQUE,

  -- Who it was issued to, in Henry's words: "Ambassadors Aug 2026 — card 7".
  -- Ops need this to answer "did Sam's code work?" and to revoke the right row.
  -- It is stored SEPARATELY from anything derived from the code on purpose: it
  -- must never be possible to recover the code from the label, or a leak of
  -- this table would be a leak of the codes by another route. The generator
  -- writes only the operator's free text here, never the code or a prefix of it.
  label        TEXT,

  -- Room for 'trial_30d' or similar later without a migration on the hot path.
  -- CHECKed rather than free text so a typo cannot mint a grant type the edge
  -- function has never heard of and will not know how to honour.
  grant_type   TEXT        NOT NULL DEFAULT 'lifetime'
                           CHECK (grant_type IN ('lifetime')),

  -- Single-use by default. max_uses exists for the "one code on a poster at a
  -- launch event" case; use_count is the thing the atomic guard tests against.
  max_uses     INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  use_count    INTEGER     NOT NULL DEFAULT 0 CHECK (use_count >= 0),

  -- The FIRST redeemer, for support ("who used card 7?"). ON DELETE SET NULL so
  -- deleting an account cannot fail on this FK — delete-account must never be
  -- blocked by an audit row (App Review 5.1.1(v)), and the entitlement row below
  -- carries the same association with a cascade.
  redeemed_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  redeemed_at  TIMESTAMPTZ,

  -- The CODE may expire even though the GRANT does not. A printed card that
  -- never made it out of the box should stop working; the lifetime Pro it would
  -- have granted, once granted, is forever. NULL = the card never goes stale.
  expires_at   TIMESTAMPTZ,

  -- Kill switch for a code that leaked (photographed at an event, posted in a
  -- group chat). Checked in the same atomic guard as everything else, so
  -- revoking takes effect on the very next attempt with no cache to bust.
  revoked_at   TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL when minted by the generator script (which runs as the service role
  -- and has no user id to attribute).
  created_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.redemption_codes ENABLE ROW LEVEL SECURITY;

-- INTENTIONALLY NOT ONE POLICY, for any client role.
--
-- There is no such thing as a safe client-readable column on this table. The
-- hash is the credential's verifier; `label` says who to social-engineer;
-- `use_count`/`max_uses`/`expires_at` tell an attacker which rows are still
-- worth attacking; even the row COUNT tells them how many live codes exist,
-- which is the numerator of every guessing calculation. Any read here is a step
-- towards a free subscription, so there is no read here.
--
-- RLS alone would not be enough: Supabase's default privileges grant `anon` and
-- `authenticated` table-wide DML on new tables in `public`, and RLS with zero
-- policies plus a live grant is one accidentally-added policy away from being
-- wide open. Revoke the grant as well so both layers have to fail.
REVOKE ALL ON public.redemption_codes FROM anon, authenticated;

-- Support lookup: "which code did this user redeem?" Small table, but this is
-- the only query shape other than the by-hash probe the UNIQUE index serves.
CREATE INDEX IF NOT EXISTS redemption_codes_redeemed_by_idx
  ON public.redemption_codes (redeemed_by)
  WHERE redeemed_by IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- Why a user has Pro
-- ─────────────────────────────────────────────────────────────────────────────
-- `profiles.subscription_status` records THAT a user is Pro. It cannot record
-- WHY, and for a lifetime grant that matters more than for a subscription: a
-- subscription re-proves itself every month through the RevenueCat webhook, but
-- a lifetime grant is written once and then never questioned again. Without a
-- row saying where it came from, a manually-flipped profile and a legitimately
-- redeemed code are indistinguishable forever, and revoking a grant made in
-- error means guessing.
--
-- This table is also what makes an idempotent replay possible: it is the record
-- that says "this user already redeemed this code", which is how the same
-- person pasting the same code twice gets a success instead of "invalid".
CREATE TABLE IF NOT EXISTS public.user_entitlements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  entitlement TEXT        NOT NULL DEFAULT 'pro' CHECK (entitlement IN ('pro')),

  -- Where the entitlement came from. 'revenuecat' and 'stripe' are declared now
  -- so those paths can start writing here without a migration; today only
  -- redeem_code() below writes this table.
  source      TEXT        NOT NULL
                          CHECK (source IN ('redemption_code', 'revenuecat', 'stripe')),
  -- redemption_codes.id for 'redemption_code'. TEXT because the other sources'
  -- identifiers are opaque third-party strings, not UUIDs.
  source_id   TEXT,

  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set to withdraw a grant made in error. Nothing here deletes rows: the point
  -- of the table is the audit trail, and a deleted row audits nothing.
  revoked_at  TIMESTAMPTZ,
  -- NULL = lifetime. Same convention as profiles.subscription_expires_at, which
  -- lib/subscription.ts already reads as perpetual rather than expired.
  expires_at  TIMESTAMPTZ,

  -- Makes re-granting idempotent: a replayed redemption hits this constraint
  -- and updates nothing instead of stacking duplicate audit rows.
  UNIQUE (user_id, entitlement, source, source_id)
);

ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;

-- Start from nothing. Supabase's default privileges hand `anon` and
-- `authenticated` table-wide DML on new public tables, and that default is
-- catastrophic here specifically: a user who can INSERT into this table can
-- write their own reason-for-Pro row, and a user who can UPDATE it can
-- un-revoke a grant that was withdrawn. There is no version of this feature
-- that survives a client being able to write its own entitlement — that is the
-- whole product, given away — so the write grants are not merely policy-gated,
-- they do not exist. Only the service role (redeem_code() below, and the
-- billing webhooks later) writes here.
REVOKE ALL ON public.user_entitlements FROM anon, authenticated;
GRANT SELECT ON public.user_entitlements TO authenticated;

-- The one thing a client may do: read its OWN reasons. The Profile screen can
-- then say "Lifetime — redeemed 3 Aug 2026" instead of a bare "Pro", and a
-- support conversation can start from what the user can see. Scoped to
-- auth.uid() so it is never a census of who else got a free lifetime.
DROP POLICY IF EXISTS "Users can view own entitlements" ON public.user_entitlements;
CREATE POLICY "Users can view own entitlements"
  ON public.user_entitlements
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS user_entitlements_user_id_idx
  ON public.user_entitlements (user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- Redemption — one statement, one winner
-- ─────────────────────────────────────────────────────────────────────────────
-- The obvious implementation is read-then-write: SELECT the code, check it is
-- unused, UPDATE use_count, grant. Migration 016's header explains at length
-- why that shape is not a check at all — every concurrent caller reads the same
-- pre-increment value, every one passes, and "single use" becomes "as many uses
-- as you can fire in one round trip". A redemption code is exactly the kind of
-- thing an attacker WILL fire concurrently: they only need one code to leak
-- once, and then the race is worth a subscription per parallel request.
--
-- So consumption is a single UPDATE whose WHERE clause IS the eligibility test.
-- Under READ COMMITTED the second writer blocks on the row lock, and when the
-- first commits it re-evaluates the predicate against the NEW row — where
-- use_count is now 1 and max_uses is 1, so it matches nothing and reports zero
-- rows affected. Postgres does the arbitration; no advisory lock, no retry loop.
--
-- Signature note: the function takes a HASH, never a code. The pepper and the
-- plaintext both stay outside the database (see the header), so there is
-- nothing to compare in string space and no plaintext in a log_statement dump.
CREATE OR REPLACE FUNCTION public.redeem_code(p_code_hash TEXT, p_user UUID)
RETURNS TABLE (status TEXT, grant_type TEXT, code_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned per migration 010: a SECURITY DEFINER function with a mutable
-- search_path can be hijacked by a caller who creates a shadowing object in a
-- schema earlier on the path. This one writes billing state, so a hijack here
-- is a free subscription for anyone who can create a temp table.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code_id UUID;
  v_grant   TEXT;
  v_status  TEXT;
BEGIN
  -- Defensive, not decorative: p_user lands in user_entitlements.user_id and
  -- selects the profiles row to flip. A NULL arriving here would mean the
  -- caller failed to establish who is redeeming, and the correct response to
  -- that is to do nothing at all rather than to grant something to nobody.
  IF p_user IS NULL OR p_code_hash IS NULL OR length(p_code_hash) = 0 THEN
    RAISE EXCEPTION 'redeem_code: user and code hash are required';
  END IF;

  -- THE ATOMIC STEP. Every eligibility condition lives in the WHERE clause so
  -- that "still has uses / not revoked / not expired" is decided under the same
  -- row lock that performs the increment. Splitting any one of these out into
  -- an IF above would reintroduce exactly the race this shape exists to remove.
  UPDATE public.redemption_codes c
     SET use_count   = c.use_count + 1,
         -- COALESCE keeps the FIRST redeemer on a multi-use code; for the
         -- single-use default it is simply "the redeemer".
         redeemed_by = COALESCE(c.redeemed_by, p_user),
         redeemed_at = COALESCE(c.redeemed_at, now())
   WHERE c.code_hash = p_code_hash
     AND c.use_count < c.max_uses
     AND c.revoked_at IS NULL
     AND (c.expires_at IS NULL OR c.expires_at > now())
  RETURNING c.id, c.grant_type INTO v_code_id, v_grant;

  IF FOUND THEN
    v_status := 'granted';
  ELSE
    -- Nothing was consumed. Before calling it a failure, ask the one question
    -- that distinguishes an attacker from a user who tapped Redeem twice or
    -- reinstalled the app: does THIS user already hold a live entitlement from
    -- THIS code? If so the code did its job and saying "invalid" would be a lie
    -- that generates a support ticket.
    --
    -- This is safe against the double-tap race, too. The loser of the UPDATE
    -- above was blocked on the winner's row lock until the winner COMMITTED, so
    -- by the time this statement takes its (fresh, READ COMMITTED) snapshot the
    -- winner's entitlement row is visible — the same user double-tapping gets
    -- 'already_granted', not 'unavailable'.
    --
    -- revoked_at IS NULL matters: if an admin withdrew the entitlement, the
    -- code is spent AND the grant is gone, so replaying it must NOT resurrect
    -- access. It falls through to 'unavailable'.
    SELECT c.id, c.grant_type
      INTO v_code_id, v_grant
      FROM public.redemption_codes c
     WHERE c.code_hash = p_code_hash
       AND c.revoked_at IS NULL
       AND EXISTS (
         SELECT 1
           FROM public.user_entitlements e
          WHERE e.user_id = p_user
            AND e.source = 'redemption_code'
            AND e.source_id = c.id::TEXT
            AND e.revoked_at IS NULL
       );

    IF NOT FOUND THEN
      -- Not a real code / already spent by someone else / revoked / expired.
      -- ONE outcome for all four — the caller cannot tell them apart and
      -- neither can anyone probing it. See redeem-code/index.ts for why the
      -- edge function keeps them merged all the way to the wire.
      RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TEXT, NULL::UUID;
      RETURN;
    END IF;

    v_status := 'already_granted';
  END IF;

  -- ── Granting, from here down, is identical for both paths ────────────────
  -- Replays re-assert rather than skip. It costs one no-op INSERT and one
  -- profiles UPDATE, and it self-heals the case that would otherwise be
  -- unfixable without SQL access: a lifetime holder whose profile got written
  -- back to 'expired' by an unrelated store event can paste their card again
  -- and be whole. The audit row is untouched, so the history stays honest.

  -- ON CONFLICT DO NOTHING, deliberately NOT DO UPDATE. A DO UPDATE that
  -- cleared revoked_at would turn "replay your own code" into "undo an
  -- administrative revocation", which is precisely the power this table exists
  -- to keep out of users' hands.
  INSERT INTO public.user_entitlements (user_id, entitlement, source, source_id, expires_at)
  VALUES (p_user, 'pro', 'redemption_code', v_code_id::TEXT, NULL)
  ON CONFLICT (user_id, entitlement, source, source_id) DO NOTHING;

  -- The gate the rest of the app actually reads. `checkSubscriptionDeterminate`
  -- (lib/subscription.ts) and `public.has_active_pro()` (017) both treat
  -- status='active' with a NULL expiry as a live, non-expiring entitlement, so
  -- this is the whole of "Pro is on" — no client change needed anywhere.
  -- Only the service role can reach these columns (013), and this function is
  -- service-role-only (below), so this is the single path that can write them
  -- outside the billing webhooks.
  UPDATE public.profiles
     SET subscription_status     = 'active',
         subscription_expires_at = NULL,
         updated_at              = now()
   WHERE id = p_user;

  RETURN QUERY SELECT v_status, v_grant, v_code_id;
END;
$$;

-- The most dangerous grant in the schema if it were wrong. This function is
-- SECURITY DEFINER and takes the beneficiary as an ARGUMENT — so any role that
-- can execute it can grant lifetime Pro to any user id it likes, and (for a
-- multi-use code) can do it repeatedly. `authenticated` must never hold it.
-- The only caller is the redeem-code edge function, which runs as the service
-- role and passes a user id it read out of a verified JWT.
REVOKE ALL ON FUNCTION public.redeem_code(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_code(TEXT, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_code(TEXT, UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Rate-limit refund
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to public.consume_rate_limit() (016). It lives in this migration
-- because this is the endpoint that needs it and it is the only caller.
--
-- WHY A REFUND EXISTS AT ALL
-- redeem-code charges the limiter BEFORE it touches the codes table, so a
-- caller who is over budget is stopped before any lookup happens — the limiter
-- protects the database, not just the status code. But the budget is meant to
-- bound WRONG GUESSES, and an ambassador who fat-fingers their card twice and
-- gets it right on the third go should not be left with a spent allowance. So
-- the successful attempt hands its unit back.
--
-- WHY THIS IS NOT A HOLE
-- A refund is only reachable by actually redeeming a code — i.e. by presenting
-- a valid, unspent, unrevoked 80-bit secret. "Burn a real code to recover one
-- rate-limit unit" is not an attack. And service_role-only, like everything in
-- 016: a client that could call this could zero its own counter.
--
-- The window is recomputed exactly as consume_rate_limit computes it. A refund
-- that lands after a window boundary decrements a fresh counter instead of the
-- one it paid into; that under-counts by at most one unit, once per successful
-- redemption, which is noise. GREATEST(0, …) keeps it from ever going negative.
CREATE OR REPLACE FUNCTION public.refund_rate_limit(
  p_bucket   TEXT,
  p_subject  TEXT,
  p_window_seconds INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
BEGIN
  IF p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'refund_rate_limit: window must be positive';
  END IF;

  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  UPDATE public.api_rate_limit AS l
     SET count = GREATEST(0, l.count - 1)
   WHERE l.bucket = p_bucket
     AND l.subject = p_subject
     AND l.window_start = v_window_start
  RETURNING l.count INTO v_count;

  RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_rate_limit(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_rate_limit(TEXT, TEXT, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_rate_limit(TEXT, TEXT, INTEGER) TO service_role;


-- PostgREST caches the schema; without this the new RPCs 404 and the new tables
-- are invisible until it restarts.
NOTIFY pgrst, 'reload schema';
