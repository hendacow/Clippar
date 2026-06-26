-- Apple Sign-in refresh tokens, for Sign-in-with-Apple TOKEN REVOCATION on
-- account deletion (App Store Guideline 5.1.1(v)).
--
-- Apple requires apps offering "Sign in with Apple" to revoke the user's Apple
-- token when they delete their account. Revocation needs a token Apple issued —
-- which the native `signInWithIdToken` flow never captures (it only sends the
-- identity token). So at sign-in we exchange the one-time authorization code for
-- a refresh token (server-side, in the `apple-link` Edge Function) and stash it
-- here; `delete-account` reads it back to call Apple's /auth/revoke endpoint.
--
-- We store `client_id` too: the native flow issues the code/token for the app's
-- BUNDLE ID (com.clippar.app[.dev/.staging]), and the revoke request must use
-- the SAME client_id the token was minted for. Capturing it removes any guessing
-- across dev/staging/prod builds.
--
-- SECURITY: this table holds long-lived Apple refresh tokens. It is RLS-enabled
-- with NO policies, so it is unreachable from the anon/auth client keys — only
-- the service role (used by the Edge Functions) can read or write it. The row is
-- keyed to auth.users with ON DELETE CASCADE so it disappears with the account.

CREATE TABLE IF NOT EXISTS apple_credentials (
  user_id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,

  -- The OAuth client_id the refresh token was issued for. For native Sign in
  -- with Apple this is the app's bundle identifier (read from the identity
  -- token's `aud` claim at link time).
  client_id TEXT NOT NULL,

  -- Apple refresh token from the authorization-code exchange. Single value per
  -- user; re-linking (e.g. a new device) upserts it.
  refresh_token TEXT NOT NULL,

  -- Apple's stable subject identifier for this user (identity token `sub`).
  -- Informational; handy for support/debugging without exposing the token.
  apple_sub TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS on, zero policies → no client (anon/authenticated) access at all. The
-- service role bypasses RLS, which is the only context that touches this table.
ALTER TABLE apple_credentials ENABLE ROW LEVEL SECURITY;

-- Keep updated_at honest on upsert without client cooperation. Mirrors the
-- pattern used by course_presets (migration 009).
CREATE OR REPLACE FUNCTION touch_apple_credentials_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
-- Pinned search_path per migration 010's hardening of SECURITY-sensitive fns.
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apple_credentials_updated_at ON apple_credentials;
CREATE TRIGGER apple_credentials_updated_at
  BEFORE UPDATE ON apple_credentials
  FOR EACH ROW EXECUTE FUNCTION touch_apple_credentials_updated_at();

COMMENT ON TABLE apple_credentials IS
  'Apple Sign-in refresh tokens for SiwA revocation on account deletion (5.1.1(v)). Service-role only.';
