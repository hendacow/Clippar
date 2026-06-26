/**
 * Unit tests for the delete-account purge routine.
 *
 * Run from clippar_app/ with the service-client env stubbed (the module
 * constructs a supabase client at import; the tests never use it):
 *
 *   SUPABASE_URL=http://localhost.test SUPABASE_SERVICE_ROLE_KEY=test \
 *     deno test --allow-env supabase/functions/delete-account/index.test.ts
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isAlreadyDeletedError,
  purgeAndDeleteUser,
  revokeAppleForUser,
  type DeleteClient,
} from './index.ts';

const USER = 'user-123';

/** Export a freshly generated P-256 private key as PKCS#8 PEM (for client secret). */
async function makePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A fake DeleteClient that records every table delete and the auth delete. */
function makeClient(opts: {
  rounds?: { id: string }[];
  files?: Record<string, { name: string }[]>;
  deleteUserError?: { message?: string; status?: number } | null;
  appleCreds?: { refresh_token: string; client_id: string }[];
} = {}) {
  const deletes: { table: string; col: string; val: string | string[] }[] = [];
  const removed: string[] = [];
  let deleteUserCalledWith: string | null = null;

  const client: DeleteClient = {
    from: (table: string) => ({
      select: () => ({
        eq: async () => ({
          data:
            table === 'apple_credentials'
              ? opts.appleCreds ?? []
              : opts.rounds ?? [],
        }),
      }),
      delete: () => ({
        eq: async (col: string, val: string) => {
          deletes.push({ table, col, val });
          return null;
        },
        in: async (col: string, vals: string[]) => {
          deletes.push({ table, col, val: vals });
          return null;
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        list: async (path: string) => ({ data: opts.files?.[`${bucket}/${path}`] ?? [] }),
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return null;
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          deleteUserCalledWith = id;
          return { error: opts.deleteUserError ?? null };
        },
      },
    },
  };

  return {
    client,
    deletes,
    removed,
    get deleteUserCalledWith() {
      return deleteUserCalledWith;
    },
  };
}

Deno.test('isAlreadyDeletedError: classifies the idempotent cases', () => {
  assertEquals(isAlreadyDeletedError(null), false);
  assertEquals(isAlreadyDeletedError({ message: 'something broke' }), false);
  assert(isAlreadyDeletedError({ status: 404 }));
  assert(isAlreadyDeletedError({ message: 'User not found' }));
  assert(isAlreadyDeletedError({ message: 'user_not_found' }));
});

Deno.test('purgeAndDeleteUser: deletes every user-owned table then the auth user', async () => {
  const h = makeClient({ rounds: [{ id: 'r1' }, { id: 'r2' }] });
  await purgeAndDeleteUser(h.client, USER);

  const tablesDeleted = h.deletes.map((d) => d.table);
  for (const t of [
    'shots',
    'processing_jobs',
    'scores',
    'rounds',
    'course_presets',
    'daily_usage',
    'hardware_orders',
    'admin_users',
    'apple_credentials',
    'profiles',
  ]) {
    assert(tablesDeleted.includes(t), `expected a delete on ${t}`);
  }
  // Leaf rows (shots/jobs) must be cleared before the parent rounds row.
  assert(
    tablesDeleted.indexOf('shots') < tablesDeleted.indexOf('rounds'),
    'shots must be deleted before rounds'
  );
  // scores deleted by the round ids we found.
  const scores = h.deletes.find((d) => d.table === 'scores');
  assertEquals(scores?.col, 'round_id');
  assertEquals(scores?.val, ['r1', 'r2']);
  assertEquals(h.deleteUserCalledWith, USER);
});

Deno.test('purgeAndDeleteUser: no rounds → skips the scores .in() delete', async () => {
  const h = makeClient({ rounds: [] });
  await purgeAndDeleteUser(h.client, USER);
  assert(!h.deletes.some((d) => d.table === 'scores'), 'no scores delete without rounds');
  assertEquals(h.deleteUserCalledWith, USER);
});

Deno.test('purgeAndDeleteUser: idempotent when the auth user is already gone', async () => {
  const h = makeClient({ deleteUserError: { status: 404, message: 'User not found' } });
  // Should resolve, not throw.
  await purgeAndDeleteUser(h.client, USER);
  assertEquals(h.deleteUserCalledWith, USER);
});

Deno.test('purgeAndDeleteUser: throws on a real auth-delete failure', async () => {
  const h = makeClient({ deleteUserError: { status: 500, message: 'database is on fire' } });
  await assertRejects(() => purgeAndDeleteUser(h.client, USER), Error, 'Failed to delete account');
});

Deno.test('purgeAndDeleteUser: removes storage objects under each round', async () => {
  const h = makeClient({
    rounds: [{ id: 'r1' }],
    files: { 'clips/r1': [{ name: 'a.mp4' }], 'reels/r1': [{ name: 'reel.mp4' }] },
  });
  await purgeAndDeleteUser(h.client, USER);
  assert(h.removed.includes('r1/a.mp4'));
  assert(h.removed.includes('r1/reel.mp4'));
});

// ── Sign-in-with-Apple revocation ───────────────────────────────────────────

const APPLE_ENV_KEYS = ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'];
function clearAppleEnv() {
  for (const k of APPLE_ENV_KEYS) Deno.env.delete(k);
}
async function setAppleEnv() {
  Deno.env.set('APPLE_TEAM_ID', 'TEAMID1234');
  Deno.env.set('APPLE_KEY_ID', 'KEYID56789');
  Deno.env.set('APPLE_PRIVATE_KEY', await makePrivateKeyPem());
}

Deno.test('revokeAppleForUser: no Apple env → false (skips cleanly)', async () => {
  clearAppleEnv();
  const h = makeClient({ appleCreds: [{ refresh_token: 'rt', client_id: 'com.clippar.app' }] });
  assertEquals(await revokeAppleForUser(h.client, USER), false);
});

Deno.test('revokeAppleForUser: no stored credentials → false', async () => {
  await setAppleEnv();
  try {
    const h = makeClient({ appleCreds: [] });
    assertEquals(await revokeAppleForUser(h.client, USER), false);
  } finally {
    clearAppleEnv();
  }
});

Deno.test('revokeAppleForUser: stored token → posts to Apple /auth/revoke', async () => {
  await setAppleEnv();
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('', { status: 200 });
  }) as typeof fetch;
  try {
    const h = makeClient({
      appleCreds: [{ refresh_token: 'rt-abc', client_id: 'com.clippar.app' }],
    });
    const attempted = await revokeAppleForUser(h.client, USER);
    assertEquals(attempted, true);
    const revoke = calls.find((c) => c.url.includes('/auth/revoke'));
    assert(revoke, 'should POST to /auth/revoke');
    assert(revoke!.body.includes('token=rt-abc'));
    assert(revoke!.body.includes('token_type_hint=refresh_token'));
    assert(revoke!.body.includes('client_id=com.clippar.app'));
  } finally {
    globalThis.fetch = realFetch;
    clearAppleEnv();
  }
});

Deno.test('revokeAppleForUser: Apple endpoint error does not throw', async () => {
  await setAppleEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('bad', { status: 400 })) as typeof fetch;
  try {
    const h = makeClient({
      appleCreds: [{ refresh_token: 'rt', client_id: 'com.clippar.app' }],
    });
    // Returns true (a token existed + attempt made), swallows the 400.
    assertEquals(await revokeAppleForUser(h.client, USER), true);
  } finally {
    globalThis.fetch = realFetch;
    clearAppleEnv();
  }
});
