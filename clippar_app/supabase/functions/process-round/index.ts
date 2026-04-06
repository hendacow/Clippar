import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    // Update round status
    await supabase
      .from('rounds')
      .update({ status: 'processing' })
      .eq('id', round_id);

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
