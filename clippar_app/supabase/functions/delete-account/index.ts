import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * delete-account — App Review 5.1.1(v) in-app account deletion.
 *
 * Auth: the caller's own JWT (Authorization: Bearer <access_token>). The
 * function only ever deletes the AUTHENTICATED user — no user id is accepted
 * in the body, so it cannot be aimed at anyone else.
 *
 * Order matters:
 *   1. Storage objects (clips/<roundId>/*, reels/<roundId>/*) — these do NOT
 *      cascade and would orphan billable storage.
 *   2. daily_usage + hardware_orders rows — FK to profiles WITHOUT cascade,
 *      so they'd block the auth-user delete. (Stripe retains the payment
 *      records; the app rows hold no accounting source of truth.)
 *   3. auth.admin.deleteUser — cascades profiles → rounds → scores/shots/
 *      processing_jobs, and course_presets via their auth.users FK.
 *
 * Sign in with Apple: Apple also expects token revocation via the SiwA REST
 * API (TODO: needs the Services-ID client secret; tracked in
 * docs/APP_STORE_READINESS.md). Supabase deletion below still fully removes
 * the account and data.
 */
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // 1. Storage cleanup, keyed by the user's round ids.
    const { data: rounds } = await supabase
      .from('rounds')
      .select('id')
      .eq('user_id', user.id);
    for (const round of rounds ?? []) {
      for (const bucket of ['clips', 'reels']) {
        try {
          const { data: files } = await supabase.storage.from(bucket).list(round.id);
          if (files && files.length > 0) {
            await supabase.storage
              .from(bucket)
              .remove(files.map((f) => `${round.id}/${f.name}`));
          }
        } catch (err) {
          // Never let storage cleanup block the deletion the user asked for.
          console.error(`storage cleanup ${bucket}/${round.id} failed`, err);
        }
      }
    }

    // 2. Non-cascading FK rows that would block the auth delete.
    await supabase.from('daily_usage').delete().eq('user_id', user.id);
    await supabase.from('hardware_orders').delete().eq('user_id', user.id);

    // 2b. RevenueCat subscriber cleanup (best-effort). This removes the
    // customer record so the deleted account isn't tracked, but it does NOT
    // cancel an active App Store subscription — only the user can do that in
    // iOS Settings (the app warns them before reaching this point). Skipped
    // when no secret key is configured.
    const rcSecret = Deno.env.get('REVENUECAT_SECRET_KEY');
    if (rcSecret) {
      try {
        await fetch(
          `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(user.id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${rcSecret}` } }
        );
      } catch (err) {
        console.error('revenuecat subscriber delete failed', err);
      }
    }

    // 3. The auth user — cascades everything else.
    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteError) {
      console.error('auth delete failed', deleteError);
      return json({ error: 'Failed to delete account' }, 500);
    }

    return json({ success: true });
  } catch (err) {
    console.error('delete-account error', err);
    return json({ error: 'Internal error' }, 500);
  }
});
