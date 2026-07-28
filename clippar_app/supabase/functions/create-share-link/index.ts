import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { crypto } from 'https://deno.land/std/crypto/mod.ts';
import { enforceRateLimits, RATE_LIMITS } from '../_shared/rateLimit.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  try {
    const { round_id } = await req.json();

    // Authenticate user
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Rate limit AFTER authenticating, so the counter is keyed to a real account
    // rather than lumping every anonymous caller into one bucket. Minting a share
    // token is cheap individually but writes to `rounds` and is otherwise
    // unbounded.
    const limited = await enforceRateLimits(
      supabase,
      RATE_LIMITS.createShareLink,
      user.id,
      { 'Content-Type': 'application/json' },
    );
    if (limited) return limited;

    // `round_id` goes straight into a PostgREST filter on a uuid column. A
    // non-uuid makes Postgres raise, which used to surface as a 500 carrying the
    // database's own error text. Reject the shape here instead.
    if (typeof round_id !== 'string' || !UUID_RE.test(round_id)) {
      return new Response(JSON.stringify({ error: 'Invalid round id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check round belongs to user
    const { data: round } = await supabase
      .from('rounds')
      .select('id, share_token')
      .eq('id', round_id)
      .eq('user_id', user.id)
      .single();

    if (!round) {
      return new Response(JSON.stringify({ error: 'Round not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate share token if not exists
    let shareToken = round.share_token;
    if (!shareToken) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      shareToken = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      await supabase
        .from('rounds')
        .update({ share_token: shareToken })
        .eq('id', round_id);
    }

    const baseUrl = Deno.env.get('SHARE_BASE_URL') || 'https://clippargolf.com';
    const shareUrl = `${baseUrl}/r/${shareToken}`;

    return new Response(JSON.stringify({ share_url: shareUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // Log the detail, return a stable public string. Echoing err.message handed
    // the caller whatever Postgres, Deno or the Supabase client happened to say —
    // constraint names, column names, internal hostnames — which is free schema
    // reconnaissance (spec 5.3, "Error leakage").
    console.error('[create-share-link]', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Could not create share link.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
