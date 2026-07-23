import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

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

    // Atomically claim the round before dispatching. The UPDATE only matches
    // rounds NOT already in-flight or finished ('processing'/'ready'), so
    // concurrent/duplicate invocations for the same round update zero rows and
    // are rejected here — without this guard each call fired a fresh ~14-min
    // Modal GPU job, enabling a compute-bill DoS by looping the endpoint.
    const { data: claimed } = await supabase
      .from('rounds')
      .update({ status: 'processing' })
      .eq('id', round_id)
      .in('status', ['recording', 'uploading', 'failed'])
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
          // Modal returned an error
          await supabase
            .from('rounds')
            .update({ status: 'failed' })
            .eq('id', round_id);
          return new Response(
            JSON.stringify({ error: data?.error || 'Pipeline failed' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      } else {
        await supabase
          .from('rounds')
          .update({ status: 'failed' })
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
