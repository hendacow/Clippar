import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import {
  generateAppleClientSecret,
  getAppleConfig,
  revokeAppleToken,
} from '../_shared/apple.ts';

/**
 * delete-account — App Review 5.1.1(v) in-app account deletion.
 *
 * Auth: the caller's own JWT (Authorization: Bearer <access_token>). The
 * function only ever deletes the AUTHENTICATED user — no user id is accepted
 * in the body, so it cannot be aimed at anyone else.
 *
 * Deletion is EXPLICIT and FK-safe rather than relying solely on the
 * auth.users → profiles cascade. The schema has two foot-guns:
 *   • shots.user_id and processing_jobs.user_id reference profiles(id) with
 *     NO ON DELETE action — they only disappear via their round_id cascade,
 *     so the profile delete depends on the round cascade firing first.
 *   • admin_users.user_id references auth.users with NO ON DELETE action —
 *     an admin row would block auth.admin.deleteUser entirely.
 * Deleting each user-owned table up front removes that fragility and makes
 * the whole operation idempotent (every DELETE … WHERE user_id = … is a
 * no-op the second time around).
 *
 * Order (children before parents):
 *   1. Storage objects (clips/<roundId>/*, reels/<roundId>/*) — these do NOT
 *      cascade and would orphan billable storage.
 *   2. shots, processing_jobs, scores (by round), then rounds — clears the
 *      round subtree explicitly.
 *   3. course_presets, daily_usage, hardware_orders, admin_users — other
 *      tables keyed to the user. (Stripe retains its own payment records;
 *      these app rows hold no accounting source of truth.)
 *   4. RevenueCat subscriber (best-effort) — detaches the customer but does
 *      NOT cancel an active App Store subscription (only the user can, in iOS
 *      Settings; the app warns them before reaching this point).
 *   4b. Sign-in-with-Apple revocation (best-effort) — if the user linked Apple,
 *      revoke their stored refresh token with Apple's /auth/revoke before the
 *      apple_credentials row is removed. See revokeAppleForUser + _shared/apple.
 *   5. profiles, then auth.admin.deleteUser — the account itself.
 *
 * SiwA note: the refresh token is captured at sign-in by the apple-link function
 * and the client_id is the app's BUNDLE ID (read from the identity token's aud),
 * not the web Services ID. Revocation is best-effort and never blocks deletion.
 */
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Minimal shape of the supabase service client this routine touches. Declared
// so purgeAndDeleteUser can be unit-tested against a fake client without the
// Deno runtime. (The real client satisfies it structurally.)
export interface DeleteClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string
      ) => Promise<{ data: Record<string, string>[] | null }>;
    };
    delete: () => {
      eq: (col: string, val: string) => Promise<unknown>;
      in: (col: string, vals: string[]) => Promise<unknown>;
    };
  };
  storage: {
    from: (bucket: string) => {
      list: (path: string) => Promise<{ data: { name: string }[] | null }>;
      remove: (paths: string[]) => Promise<unknown>;
    };
  };
  auth: {
    admin: {
      deleteUser: (
        id: string
      ) => Promise<{ error: { message?: string; status?: number } | null }>;
    };
  };
}

/** True when a deleteUser error means the user is already gone (idempotent retry). */
export function isAlreadyDeletedError(error: {
  message?: string;
  status?: number;
} | null): boolean {
  if (!error) return false;
  const msg = `${error.message ?? ''}`.toLowerCase();
  return (
    error.status === 404 ||
    msg.includes('not found') ||
    msg.includes('user_not_found')
  );
}

/**
 * Sign-in-with-Apple token revocation (App Store 5.1.1(v)). Best-effort: if the
 * user linked Apple (a refresh token is stored) and Apple signing is configured,
 * revoke the token with Apple before the account row disappears. Never throws —
 * a revoke failure must not block the data deletion the user asked for.
 *
 * Returns true when a token was found and a revoke request was attempted (so the
 * caller knows there was Apple state), false when there was nothing to do.
 */
export async function revokeAppleForUser(
  client: DeleteClient,
  userId: string
): Promise<boolean> {
  const appleConfig = getAppleConfig();
  if (!appleConfig) return false; // feature not configured
  let row: Record<string, string> | undefined;
  try {
    const { data } = await client
      .from('apple_credentials')
      .select('refresh_token, client_id')
      .eq('user_id', userId);
    row = (data ?? [])[0];
  } catch (err) {
    console.error('apple revoke: lookup failed', err);
    return false;
  }
  if (!row?.refresh_token || !row?.client_id) return false;
  try {
    const clientSecret = await generateAppleClientSecret(appleConfig, row.client_id);
    await revokeAppleToken({
      token: row.refresh_token,
      clientId: row.client_id,
      clientSecret,
      tokenTypeHint: 'refresh_token',
    });
  } catch (err) {
    // Log and carry on — Apple being unreachable can't strand the deletion.
    console.error('apple revoke failed', err);
  }
  return true;
}

/**
 * Erase every trace of `userId` and delete the auth user. Pure with respect to
 * its `client` arg (no module globals beyond the RevenueCat/Apple env reads),
 * so it's unit-testable. Returns nothing on success; throws only on a hard
 * auth-delete failure that isn't "already gone".
 */
export async function purgeAndDeleteUser(
  client: DeleteClient,
  userId: string
): Promise<void> {
  // 1. Storage cleanup, keyed by the user's round ids. Storage objects do not
  //    cascade with the auth/profile delete, so an orphan here is billable.
  const { data: rounds } = await client
    .from('rounds')
    .select('id')
    .eq('user_id', userId);
  for (const round of rounds ?? []) {
    for (const bucket of ['clips', 'reels']) {
      try {
        const { data: files } = await client.storage.from(bucket).list(round.id);
        if (files && files.length > 0) {
          await client.storage
            .from(bucket)
            .remove(files.map((f) => `${round.id}/${f.name}`));
        }
      } catch (err) {
        // Never let storage cleanup block the deletion the user asked for.
        console.error(`storage cleanup ${bucket}/${round.id} failed`, err);
      }
    }
  }

  // 2. Round subtree. Delete the leaf rows that hang off profiles without a
  //    cascade first, then the rounds (cascades scores + anything left).
  const roundIds = (rounds ?? []).map((r) => r.id);
  await client.from('shots').delete().eq('user_id', userId);
  await client.from('processing_jobs').delete().eq('user_id', userId);
  if (roundIds.length > 0) {
    await client.from('scores').delete().in('round_id', roundIds);
  }
  await client.from('rounds').delete().eq('user_id', userId);

  // 3. Other user-keyed tables.
  await client.from('course_presets').delete().eq('user_id', userId);
  await client.from('daily_usage').delete().eq('user_id', userId);
  await client.from('hardware_orders').delete().eq('user_id', userId);
  await client.from('admin_users').delete().eq('user_id', userId);

  // 4. RevenueCat subscriber cleanup (best-effort). Detaches the customer but
  //    does NOT cancel an active App Store subscription. Skipped when unset.
  const rcSecret = Deno.env.get('REVENUECAT_SECRET_KEY');
  if (rcSecret) {
    try {
      await fetch(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${rcSecret}` } }
      );
    } catch (err) {
      console.error('revenuecat subscriber delete failed', err);
    }
  }

  // 4b. Sign-in-with-Apple revocation — revoke the stored refresh token with
  //     Apple BEFORE the credentials row is removed, then delete the row. Both
  //     best-effort; the row also cascades on the auth-user delete below.
  await revokeAppleForUser(client, userId);
  await client.from('apple_credentials').delete().eq('user_id', userId);

  // 5. The profile + the auth user. Deleting the auth user also cascades
  //    profiles, but we delete the profile first so a partial earlier run
  //    can't leave a profile orphaned behind a since-revoked admin row.
  await client.from('profiles').delete().eq('id', userId);

  const { error: deleteError } = await client.auth.admin.deleteUser(userId);
  if (deleteError && !isAlreadyDeletedError(deleteError)) {
    console.error('auth delete failed', deleteError);
    throw new Error('Failed to delete account');
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    await purgeAndDeleteUser(supabase as unknown as DeleteClient, user.id);

    return json({ success: true });
  } catch (err) {
    console.error('delete-account error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

// Only bind the server when run as the entry module (Edge Function runtime).
// Importing this file from a test must not start a listener.
if (import.meta.main) {
  Deno.serve(handler);
}
