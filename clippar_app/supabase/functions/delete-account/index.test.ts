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
import { reelStoragePath } from '../../../lib/storagePaths.ts';

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
  /** Buckets whose list() throws, simulating "Bucket not found" / a storage outage. */
  brokenBuckets?: string[];
} = {}) {
  const deletes: { table: string; col: string; val: string | string[] }[] = [];
  const removed: string[] = [];
  const listed: string[] = [];
  // Mutable so a remove actually empties the folder — otherwise the paginating
  // loop in removeStorageFolder would see the same page forever.
  const files: Record<string, { name: string }[]> = {};
  for (const [k, v] of Object.entries(opts.files ?? {})) files[k] = [...v];
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
        list: async (path: string, options?: { limit?: number; offset?: number }) => {
          if (opts.brokenBuckets?.includes(bucket)) {
            throw new Error(`Bucket not found: ${bucket}`);
          }
          listed.push(`${bucket}/${path}`);
          const all = files[`${bucket}/${path}`] ?? [];
          const offset = options?.offset ?? 0;
          const limit = options?.limit ?? 100;
          return { data: all.slice(offset, offset + limit) };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths.map((p) => `${bucket}/${p}`));
          for (const p of paths) {
            const cut = p.lastIndexOf('/');
            const folder = cut === -1 ? '' : p.slice(0, cut);
            const name = p.slice(cut + 1);
            const key = `${bucket}/${folder}`;
            if (files[key]) files[key] = files[key].filter((f) => f.name !== name);
          }
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
    listed,
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

Deno.test('purgeAndDeleteUser: removes the per-hole clips of each round', async () => {
  const h = makeClient({
    rounds: [{ id: 'r1' }, { id: 'r2' }],
    files: {
      'clips/r1': [{ name: 'a.mp4' }, { name: 'b.mp4' }],
      'clips/r2': [{ name: 'c.mp4' }],
    },
  });
  await purgeAndDeleteUser(h.client, USER);
  assert(h.removed.includes('clips/r1/a.mp4'));
  assert(h.removed.includes('clips/r1/b.mp4'));
  assert(h.removed.includes('clips/r2/c.mp4'));
});

// THE BUG. The reel is uploaded to `clips/reels/<roundId>.mp4` (lib/r2.ts), a
// SIBLING of the round's clips folder. The old cleanup listed the folder
// `<roundId>` in buckets `clips` and `reels`, so it never matched the reel and
// the deleted account kept it. Both halves are locked down here.
Deno.test('purgeAndDeleteUser: removes the composed reel at its real key', async () => {
  const h = makeClient({ rounds: [{ id: 'r1' }, { id: 'r2' }] });
  await purgeAndDeleteUser(h.client, USER);
  assertEquals(reelStoragePath('r1'), 'reels/r1.mp4'); // the key r2.ts uploads to
  assert(h.removed.includes(`clips/${reelStoragePath('r1')}`), 'reel of r1 not removed');
  assert(h.removed.includes(`clips/${reelStoragePath('r2')}`), 'reel of r2 not removed');
});

Deno.test('purgeAndDeleteUser: never touches a bucket named `reels` (there is none)', async () => {
  const h = makeClient({ rounds: [{ id: 'r1' }] });
  await purgeAndDeleteUser(h.client, USER);
  assert(
    !h.listed.some((l) => l.startsWith('reels/')),
    `listed a non-existent reels bucket: ${h.listed.join(', ')}`
  );
  assert(!h.removed.some((r) => r.startsWith('reels/')));
});

Deno.test('purgeAndDeleteUser: removes the profile photo whatever its extension', async () => {
  const h = makeClient({
    rounds: [],
    files: { [`avatars/${USER}`]: [{ name: 'avatar.heic' }] },
  });
  await purgeAndDeleteUser(h.client, USER);
  assert(h.removed.includes(`avatars/${USER}/avatar.heic`), 'avatar not removed');
});

// Blast radius: everything listed or removed must be under a folder derived
// from this user's id or one of their round ids. Never the bucket root, never
// a shared prefix like `reels/`.
Deno.test('purgeAndDeleteUser: never lists a bucket root or a shared prefix', async () => {
  const h = makeClient({ rounds: [{ id: 'r1' }] });
  await purgeAndDeleteUser(h.client, USER);
  assertEquals(h.listed.sort(), ['avatars/user-123', 'clips/r1']);
  for (const key of h.removed) {
    assert(
      key.startsWith('clips/r1/') ||
        key === `clips/${reelStoragePath('r1')}` ||
        key.startsWith(`avatars/${USER}/`),
      `removed something outside the user's keyspace: ${key}`
    );
  }
});

// Storage list() truncates at 100 objects. A 36-hole round can exceed that, and
// the remainder would survive the account — undeletable once the rounds row is
// gone, because the storage policies authorise by round ownership.
Deno.test('purgeAndDeleteUser: pages past the 100-object list() limit', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `clip-${i}.mp4` }));
  const h = makeClient({ rounds: [{ id: 'r1' }], files: { 'clips/r1': many } });
  await purgeAndDeleteUser(h.client, USER);
  for (const f of many) {
    assert(h.removed.includes(`clips/r1/${f.name}`), `${f.name} left behind`);
  }
});

// The failure posture that predates this fix and must survive it: cleanup is
// best-effort, the deletion is not. A storage outage (or an `avatars` bucket
// that was never created in this project) cannot strand an account.
Deno.test('purgeAndDeleteUser: storage failures never block the account delete', async () => {
  const h = makeClient({
    rounds: [{ id: 'r1' }],
    brokenBuckets: ['clips', 'avatars'],
  });
  await purgeAndDeleteUser(h.client, USER);
  assertEquals(h.deleteUserCalledWith, USER);
  assert(h.deletes.some((d) => d.table === 'profiles'));
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
