import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import {
  decodeJwtPayload,
  generateAppleClientSecret,
  getAppleConfig,
  revokeAppleToken,
} from '../_shared/apple.ts';
import { enforceRateLimits, RATE_LIMITS } from '../_shared/rateLimit.ts';
// Reaches OUT of supabase/functions/ on purpose: this is the same module the
// app's uploader (lib/r2.ts) builds its keys from, and sharing it is the only
// thing that keeps the deleter pointed at the object the uploader wrote. It is
// a dependency-free leaf module precisely so Deno can load it. Metro blocks
// `supabase/**` from the app bundle (metro.config.js blockList), so the shared
// file cannot live under _shared/ — the app would never be able to import it.
import {
  AVATARS_BUCKET,
  avatarFolder,
  CLIPS_BUCKET,
  reelStoragePath,
  roundClipsFolder,
} from '../../../lib/storagePaths.ts';

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
 *   1. Storage objects — per-hole clips (clips/<roundId>/*), the composed reel
 *      (clips/reels/<roundId>.mp4) and the profile photo (avatars/<userId>/*).
 *      None of these cascade: what is missed here stays billable, and the reel
 *      and the avatar stay FETCHABLE by anyone holding their URL.
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
      list: (
        path: string,
        options?: { limit?: number; offset?: number }
      ) => Promise<{ data: { name: string }[] | null }>;
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
 * Remove every object directly inside `folder` of `bucket`.
 *
 * Paginated, and always re-listed from offset 0: Storage's list() returns 100
 * objects per call and silently truncates past that, and a 36-hole round can
 * hold more clips than that. Advancing an offset instead would skip the
 * objects that shift down into the page just deleted; the page bound is what
 * stops the loop if a remove is refused and the same page keeps coming back.
 *
 * Best-effort by contract. Every failure is logged and swallowed: cleanup can
 * never be allowed to block the account deletion the user asked for, and a
 * leftover object is a smaller problem than an account that will not die.
 */
async function removeStorageFolder(
  client: DeleteClient,
  bucket: string,
  folder: string
): Promise<void> {
  const PAGE = 100;
  const MAX_PAGES = 100; // 10k objects — far past anything a real round holds
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data: files } = await client.storage
        .from(bucket)
        .list(folder, { limit: PAGE });
      if (!files || files.length === 0) return;
      await client.storage
        .from(bucket)
        .remove(files.map((f) => `${folder}/${f.name}`));
      if (files.length < PAGE) return;
    }
    console.error(`storage cleanup ${bucket}/${folder}: stopped paging, objects may remain`);
  } catch (err) {
    console.error(`storage cleanup ${bucket}/${folder} failed`, err);
  }
}

/** Remove exact object keys. Same best-effort contract as removeStorageFolder. */
async function removeStorageObjects(
  client: DeleteClient,
  bucket: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await client.storage.from(bucket).remove(keys);
  } catch (err) {
    console.error(`storage cleanup ${bucket} [${keys.join(', ')}] failed`, err);
  }
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
  // 1. Storage cleanup. Storage objects do not cascade with the auth/profile
  //    delete, so anything missed here survives the account — billable at best,
  //    and still publicly fetchable at worst.
  //
  //    WHY THE OLD LOOP MISSED THE REEL, so nobody rebuilds it: it listed the
  //    FOLDER named `<roundId>` in each of two buckets, `clips` and `reels`.
  //    Neither ever contained the reel.
  //      • `clips/<roundId>/` holds the per-hole clips. The composed reel is
  //        uploaded to `clips/reels/<roundId>.mp4` (lib/r2.ts) — a SIBLING of
  //        that folder, so no listing of `<roundId>` could ever match it. The
  //        assumption baked in was "everything for a round lives in the round's
  //        folder", and that has never been true of the reel.
  //      • There is no bucket named `reels`. No migration creates one and no
  //        upload path writes to one, so that half of the loop 404'd against
  //        nothing every single run — which is worse than useless, because a
  //        log full of expected errors hides the unexpected one.
  //    Net effect: a deleted account kept its highlight reels, which the
  //    privacy policy (§9) says are deleted. Hence the derived keys below.
  //
  //    Everything removed here is derived from a user id or a round id THIS
  //    user owns. Nothing is read out of a client-writable column —
  //    rounds.reel_url in particular is user-writable, so feeding it to a
  //    service-role .remove() would let anyone aim this at a stranger's reel by
  //    editing their own row before deleting their account.
  const { data: rounds } = await client
    .from('rounds')
    .select('id')
    .eq('user_id', userId);
  for (const round of rounds ?? []) {
    // Per-hole clips: a folder of unknown contents, so list it.
    await removeStorageFolder(client, CLIPS_BUCKET, roundClipsFolder(round.id));
    // The reel: one exact key. Deliberately NOT a list of the `reels/` prefix —
    // that prefix holds every user's reels and must never be enumerated here.
    await removeStorageObjects(client, CLIPS_BUCKET, [reelStoragePath(round.id)]);
  }

  // Profile photo. `avatars` is a PUBLIC bucket keyed `<userId>/avatar.<ext>`
  // (app/profile/edit.tsx), so until now a deleted user's face stayed live on a
  // URL derivable from nothing but their user id. The extension follows
  // whatever the image picker returned, so list the user's own folder rather
  // than guessing `avatar.jpg` — and list only that folder, never the bucket.
  await removeStorageFolder(client, AVATARS_BUCKET, avatarFolder(userId));

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

    // RECENT AUTHENTICATION, enforced on the SERVER.
    //
    // The client re-challenges the user (password / Sign in with Apple / Google)
    // immediately before calling this — but a client-side gate protects only the
    // person holding the phone. The attack this closes is the other one: someone
    // holding a stolen access token POSTs this endpoint directly with curl and
    // destroys the account and every reel the user has published. No app, no
    // device, no UI, and not one line of that client challenge executes.
    //
    // Supabase access tokens live an hour by default, so without a freshness
    // check any token lifted in that window is a working delete-account button.
    // Requiring a recently-minted token means an attacker must have completed
    // the credential challenge themselves, which is the whole point of asking.
    //
    // Safe for the legitimate path: reauthenticate() signs in afresh, which
    // mints a NEW session, so the token arriving here is seconds old — three
    // orders of magnitude inside the window. The signature is already verified
    // by getUser above; this only reads a claim out of it.
    const MAX_TOKEN_AGE_SECONDS = 600; // 10 minutes
    try {
      const claims = decodeJwtPayload(token);
      const iat = typeof claims.iat === 'number' ? claims.iat : null;
      if (iat === null) {
        return json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' }, 401);
      }
      const ageSeconds = Math.floor(Date.now() / 1000) - iat;
      if (ageSeconds > MAX_TOKEN_AGE_SECONDS) {
        // 401 with a distinguishable code so the app can re-challenge and retry
        // rather than showing a dead end. Deliberately does NOT say how old the
        // token was or what the window is.
        return json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' }, 401);
      }
    } catch {
      // A token whose claims will not decode is not one we act on for an
      // irreversible operation. Fail closed.
      return json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' }, 401);
    }

    // Self-scoped and idempotent, so this is not an abuse target in the usual
    // sense — but each call fans out across auth, several tables and an outbound
    // token revocation to Apple on our developer credentials. A loop here is a
    // loop against Apple. Five a day is far past any legitimate use.
    const limited = await enforceRateLimits(
      supabase,
      RATE_LIMITS.deleteAccount,
      user.id,
      corsHeaders,
    );
    if (limited) return limited;

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
