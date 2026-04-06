import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std/crypto/mod.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

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
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
