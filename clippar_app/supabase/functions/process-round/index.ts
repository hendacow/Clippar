import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { enforceRateLimits } from '../_shared/rateLimit.ts';

const MODAL_PIPELINE_URL =
  'https://hendacow--clippar-shot-detector-run-full-pipeline.modal.run';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

Deno.serve(async (req: Request) => {
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
    const { data: claimed } = await supabase
      .from('rounds')
      .update({ dispatch_claimed_at: new Date().toISOString(), status: 'processing' })
      .eq('id', round_id)
      .is('dispatch_claimed_at', null)
      .select('id');

    if (!claimed || claimed.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Round is already processing or completed' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Dispatch to Modal GPU pipeline (fire and forget with timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 840_000); // 14 min

    try {
      const resp = await fetch(MODAL_PIPELINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: round_id,
          supabase_url: supabaseUrl,
          supabase_key: supabaseServiceKey,
          neon_database_url: '',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        if (data?.ok) {
          return new Response(
            JSON.stringify({
              ok: true,
              reel_url: data.reel_url,
              detection_time_sec: data.detection_time_sec,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        } else {
          // Modal returned an error. Release the claim (clear
          // dispatch_claimed_at) alongside marking the round failed, so a
          // legitimate retry can re-dispatch. Only the service role can write
          // this column, so releasing it here does not reopen the DoS loop —
          // an attacker still can't clear it, and the daily cap bounds retries.
          await supabase
            .from('rounds')
            .update({ status: 'failed', dispatch_claimed_at: null })
            .eq('id', round_id);
          return new Response(
            JSON.stringify({ error: data?.error || 'Pipeline failed' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      } else {
        // Non-2xx from Modal: same as above — release the claim so a retry is
        // possible while keeping the column service-role-only.
        await supabase
          .from('rounds')
          .update({ status: 'failed', dispatch_claimed_at: null })
          .eq('id', round_id);
        return new Response(
          JSON.stringify({ error: `Modal HTTP ${resp.status}` }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch (err) {
      clearTimeout(timeoutId);
      // Timeout or network error — Modal may still be running
      // Don't mark as failed since Modal updates the DB directly
      return new Response(
        JSON.stringify({ ok: true, note: 'Pipeline dispatched, may still be running' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
