-- 016_api_rate_limit.sql
-- A general, ATOMIC rate limiter for the edge functions.
--
-- WHY THIS EXISTS
-- Two endpoints already had per-day caps (sync-courses, process-round) and both
-- counted with a read-then-write: SELECT the count, compare, UPDATE count + 1.
-- That races by construction. An attacker does not send requests one at a time —
-- fire 200 concurrently and every one of them reads the same pre-increment value,
-- every one passes the comparison, and the cap is simply not a cap. The comment on
-- enforceDailySyncCap conceded the race and called a small overshoot acceptable;
-- under deliberate concurrency the overshoot is unbounded, which is a different
-- thing entirely.
--
-- The fix is to make "increment and tell me the new value" one statement.
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING takes a row lock for the duration,
-- so concurrent callers serialise on the key and each observes a distinct count.
--
-- WHY A SHARED TABLE RATHER THAN ONE PER FEATURE
-- sync_course_usage was single-purpose and needed a migration per new limit. This
-- is keyed by an opaque bucket name, so adding a limit to an endpoint is a code
-- change in the function, not a schema change.

-- ─────────────────────────────────────────────────────────────────────────────
-- Counter storage
-- ─────────────────────────────────────────────────────────────────────────────
-- `subject` is deliberately TEXT and not a FK to auth.users: some limits are keyed
-- by user id, but the public reel-viewer endpoint has no user and must be keyed by
-- client IP. Keeping it opaque lets one table serve both. The bucket name carries
-- the namespace, so 'share-view:1.2.3.4' can never collide with a user uuid.
CREATE TABLE IF NOT EXISTS public.api_rate_limit (
  bucket       TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);

ALTER TABLE public.api_rate_limit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies. Service-role only, exactly like sync_course_usage.
-- A user who could read this could measure how close they are to a cap; a user who
-- could write it could reset their own counter, which would make the whole control
-- decorative.
REVOKE ALL ON public.api_rate_limit FROM anon, authenticated;

-- Sweeping expired rows is a range scan over window_start, so index it.
CREATE INDEX IF NOT EXISTS api_rate_limit_window_start_idx
  ON public.api_rate_limit (window_start);

-- ─────────────────────────────────────────────────────────────────────────────
-- The limiter
-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed-window rather than sliding. A sliding window needs either a row per request
-- or a background aggregation, and the point here is to stop abuse cheaply, not to
-- meter usage precisely. The cost of fixed windows is that a caller can spend their
-- whole budget at the end of one window and again at the start of the next; for
-- caps measured in tens per day against a golfer playing one round, that burst is
-- irrelevant.
--
-- Returns the decision AND the numbers, so the caller can set Retry-After and
-- X-RateLimit-* headers without a second round trip.
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_bucket   TEXT,
  p_subject  TEXT,
  p_limit    INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (allowed BOOLEAN, current_count INTEGER, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned per migration 010: a SECURITY DEFINER function with a mutable search_path
-- can be hijacked by a caller who creates a shadowing object in a schema earlier on
-- the path.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
BEGIN
  IF p_limit <= 0 OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'consume_rate_limit: limit and window must be positive';
  END IF;

  -- Align every caller in the same window onto the same key by flooring now() to a
  -- multiple of the window length since the epoch. Without this each caller would
  -- open its own window and nothing would ever aggregate.
  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  -- THE ATOMIC STEP. The ON CONFLICT path takes a row lock, so N concurrent callers
  -- queue here and each RETURNING sees its own distinct post-increment value. This
  -- is the whole reason the function exists.
  INSERT INTO public.api_rate_limit AS l (bucket, subject, window_start, count)
  VALUES (p_bucket, p_subject, v_window_start, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET count = l.count + 1
  RETURNING l.count INTO v_count;

  -- Note the request is counted even when it is refused. That is deliberate: a
  -- caller who keeps hammering a closed door should not have their window quietly
  -- reset by the refusals, and it makes sustained abuse visible in the table.

  RETURN QUERY SELECT
    v_count <= p_limit,
    v_count,
    GREATEST(
      0,
      CEIL(EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => p_window_seconds) - now())))
    )::INTEGER;
END;
$$;

-- Only the service role may consume a limit. If `authenticated` could call this it
-- could burn its own budget to lock itself out, or worse, burn another subject's.
REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Housekeeping
-- ─────────────────────────────────────────────────────────────────────────────
-- Counter rows are worthless once their window has closed. Nothing here runs on a
-- schedule (pg_cron is not assumed to be enabled), so the sweep is exposed as a
-- function and called opportunistically from the limiter helper — see
-- supabase/functions/_shared/rateLimit.ts, which fires it on roughly 1 call in 200.
-- At Clippar's volumes that keeps the table to a few thousand rows.
CREATE OR REPLACE FUNCTION public.sweep_rate_limits(p_older_than_seconds INTEGER DEFAULT 172800)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.api_rate_limit
  WHERE window_start < now() - make_interval(secs => p_older_than_seconds);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_rate_limits(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_rate_limits(INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_rate_limits(INTEGER) TO service_role;

-- PostgREST caches the schema; without this the new RPCs 404 until it restarts.
NOTIFY pgrst, 'reload schema';
