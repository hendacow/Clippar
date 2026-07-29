import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { enforceRateLimit, enforceRateLimits } from '../_shared/rateLimit.ts';

const MODAL_PIPELINE_URL =
  'https://hendacow--clippar-shot-detector-run-full-pipeline.modal.run';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * How long Modal is given to ACCEPT the job, not to finish it.
 *
 * This used to be 840_000 ms (14 minutes) and the handler awaited the whole GPU
 * run inside the request. Two things were wrong with that. It pinned a Supabase
 * edge worker for minutes per dispatch — 20 concurrent dispatches from one free
 * account, times a handful of free accounts, starves the project's invocation
 * pool and takes down get-shared-reel, revenuecat-webhook and delete-account
 * with it. And 840s is past the platform's own wall-clock limit, so the
 * AbortController never fired: the isolate was killed, the catch block never
 * ran, and the round sat at status='processing' with dispatch_claimed_at held
 * forever — unrecoverable, because a user cannot clear that column (migration
 * 013 excludes it from the authenticated grant).
 *
 * Modal writes the result back to `rounds` itself, so nothing here needs to wait
 * for it. Ten seconds is generous for "did you take the job".
 */
const MODAL_ACCEPT_TIMEOUT_MS = 10_000;

/**
 * A claim older than this is treated as dead and may be re-claimed.
 *
 * This is the recovery path for the wedge described above, and for any future
 * Modal run that dies without reporting. A full pipeline run is ~14 minutes, so
 * 25 leaves clear air: a job that is genuinely still running will not be
 * re-dispatched underneath itself. Re-claiming does NOT reopen the DoS the claim
 * guard was added for — the atomic 20-attempts-per-day limiter below counts
 * attempts and never decrements, so retries are still bounded whether or not the
 * claim is releasable.
 */
const STALE_CLAIM_MS = 25 * 60 * 1000;

const handler = async (req: Request): Promise<Response> => {
  try {
    // Authenticate user from JWT
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing auth token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { round_id } = await req.json();
    if (!round_id) {
      return new Response(JSON.stringify({ error: 'Missing round_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify user owns this round
    const { data: round, error: roundError } = await supabase
      .from('rounds')
      .select('id, user_id, status')
      .eq('id', round_id)
      .single();

    if (roundError || !round || round.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Round not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Per-user daily dispatch cap. Each dispatch stamps `dispatch_claimed_at`
    // (a service-role-only column), so counting this user's rounds claimed
    // since UTC midnight bounds how many Modal GPU jobs one account can launch
    // per day — a backstop against an attacker fanning many freshly-created
    // rounds through the endpoint. Set well above the app's soft limit
    // (config.processing.maxJobsPerDay = 2) so real usage, including retries of
    // a failed round, is never blocked.
    const MAX_DISPATCHES_PER_DAY = 10;

    // ATOMIC CEILING, checked first.
    //
    // The dispatch count below is a SELECT followed by a decision, which races:
    // fire 200 concurrent requests naming 200 different rounds and every one of
    // them reads the same pre-dispatch count, every one passes, and every one
    // claims its own round successfully — because the per-round claim is atomic
    // but the per-DAY cap was not. Each of those is a ~14-minute Modal GPU job we
    // pay for, which makes this the most expensive endpoint in the product to
    // leave unguarded.
    //
    // Deliberately kept ALONGSIDE the dispatch count rather than replacing it,
    // because the two measure different things. This counts ATTEMPTS and never
    // decrements; the query below counts rounds still holding a claim, and a
    // failed dispatch resets `dispatch_claimed_at` to null so a retry is not
    // penalised. Replacing it would mean a user whose rounds keep failing burns
    // their quota on our bugs. So this ceiling sits higher (20 attempts) and only
    // bites on the concurrency abuse the other check cannot see.
    const attemptLimited = await enforceRateLimits(
      supabase,
      { bucket: 'process-round-attempts', limit: 20, windowSeconds: 86_400 },
      user.id,
      { 'Content-Type': 'application/json' },
    );
    if (attemptLimited) return attemptLimited;

    // PROJECT-WIDE ceiling, keyed to a constant subject rather than a user.
    //
    // Every limit above is per-account, and accounts are free and self-serve. A
    // hundred signups each spending their 20 legitimate dispatches is 2,000
    // fourteen-minute T4 jobs, which no per-user cap can see. This bounds the
    // aggregate GPU bill regardless of how many identities are involved.
    // 100/hour is far above real traffic for this product and still bounds a
    // day's worst case to something survivable.
    const globalLimited = await enforceRateLimit(
      supabase,
      { bucket: 'process-round-global', limit: 100, windowSeconds: 3_600 },
      'global',
      { 'Content-Type': 'application/json' },
    );
    if (globalLimited) {
      // 503 rather than 429: this is our capacity being exhausted, not this
      // caller misbehaving (spec 7.5).
      return new Response(
        JSON.stringify({ error: 'Processing is at capacity. Please try again shortly.' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': globalLimited.headers.get('Retry-After') ?? '600',
          },
        },
      );
    }

    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const { count: dispatchesToday } = await supabase
      .from('rounds')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('dispatch_claimed_at', startOfDayUtc.toISOString());

    if ((dispatchesToday ?? 0) >= MAX_DISPATCHES_PER_DAY) {
      return new Response(
        JSON.stringify({ error: 'Daily processing limit reached' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Atomically claim the round before dispatching, using a service-role-only
    // stamp the client cannot write. `dispatch_claimed_at` is excluded from the
    // authenticated UPDATE grant (migration 013), so — unlike the old
    // status-based guard, where `status` is client-writable and the app legit-
    // imately rewrites it — a user cannot reset this to re-arm the claim and
    // loop the endpoint. The single conditional UPDATE is atomic: concurrent or
    // duplicate invocations for the same round match zero rows and get 409, so
    // each round dispatches at most one ~14-min Modal GPU job.
    //
    // The claim is also RELEASABLE by age: a claim older than STALE_CLAIM_MS is
    // treated as dead and may be taken again. Without that, any run that dies
    // without reporting — the killed-isolate case the old 840s await produced,
    // a Modal outage, a container OOM — wedges the round at status='processing'
    // forever with no client-visible recovery, because the user cannot write
    // dispatch_claimed_at themselves. Still one atomic UPDATE, so the race
    // properties above are unchanged.
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const { data: claimed } = await supabase
      .from('rounds')
      .update({ dispatch_claimed_at: new Date().toISOString(), status: 'processing' })
      .eq('id', round_id)
      .or(`dispatch_claimed_at.is.null,dispatch_claimed_at.lt.${staleBefore}`)
      .select('id');

    if (!claimed || claimed.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Round is already processing or completed' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Dispatch to the Modal GPU pipeline and wait only for ACCEPTANCE. Modal
    // writes the finished reel back to `rounds` itself, and the app polls the
    // row, so nothing downstream needs this request to stay open for the run.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODAL_ACCEPT_TIMEOUT_MS);

    try {
      const resp = await fetch(MODAL_PIPELINE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Idempotency key so a retried dispatch — ours after a timeout, or a
          // duplicate from the client — cannot start a SECOND GPU job for the
          // same round. round_id is the natural key: one round, one pipeline run.
          'Idempotency-Key': String(round_id),
        },
        body: JSON.stringify({
          job_id: round_id,
          idempotency_key: round_id,
          // Shared secret proving this request came from us. The Modal endpoint
          // is a public HTTPS URL whose address is committed in this very file,
          // so without this anyone can POST it and start a 15-minute T4 job on
          // our account, skipping every control above (JWT, ownership, the daily
          // cap, the atomic claim) — those guard the Supabase front door, and
          // Modal is a second door onto the same job.
          pipeline_secret: Deno.env.get('CLIPPAR_PIPELINE_SECRET') ?? '',
          // supabase_url / supabase_key deliberately NOT sent. The container
          // reads both from its own Modal secret now. Sending them meant this
          // function handed the full SERVICE ROLE key across the network on
          // every dispatch, and — because the container used the caller's URL in
          // preference to its own — anyone who could reach that endpoint could
          // point it at their own host and be handed the key.
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        // Accepted. Return immediately — the worker is free again while the GPU
        // job runs, and the app tracks completion by polling the round row that
        // Modal updates. Deliberately NOT reading a reel_url out of this
        // response: waiting for one is what held the worker open for minutes.
        return new Response(
          JSON.stringify({ ok: true, status: 'dispatched' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Modal refused the job outright. Release the claim (clear
      // dispatch_claimed_at) alongside marking the round failed, so a legitimate
      // retry can re-dispatch. Only the service role can write this column, so
      // releasing it here does not reopen the DoS loop — an attacker still can't
      // clear it, and the daily cap bounds retries.
      await supabase
        .from('rounds')
        .update({ status: 'failed', dispatch_claimed_at: null })
        .eq('id', round_id);
      // Don't relay Modal's status code or body: it describes our internal
      // infrastructure, and this response goes to the client (spec 5.3).
      console.error(`[process-round] Modal rejected dispatch: HTTP ${resp.status}`);
      return new Response(
        JSON.stringify({ error: 'Could not start processing.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      clearTimeout(timeoutId);
      // Acceptance timed out or the network failed. Modal may or may not have
      // taken the job, so leave the claim in place rather than guessing — it
      // ages out after STALE_CLAIM_MS and the round becomes re-dispatchable.
      console.error('[process-round] Modal dispatch error:', err instanceof Error ? err.message : err);
      return new Response(
        JSON.stringify({ ok: true, status: 'dispatched' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    // Log the detail, return a stable public string. `String(err)` handed the
    // caller whatever Postgres, Deno or the Supabase client happened to say —
    // column names, constraint names, dependency versions — which is free
    // reconnaissance (spec 5.3, "Error leakage").
    console.error('[process-round]', err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// Guarded so `deno test` can import this module without binding a port (same
// pattern as delete-account / revenuecat-webhook).
if (import.meta.main) {
  Deno.serve(handler);
}
