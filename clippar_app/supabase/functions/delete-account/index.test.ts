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
  type DeleteClient,
} from './index.ts';

const USER = 'user-123';

/** A fake DeleteClient that records every table delete and the auth delete. */
function makeClient(opts: {
  rounds?: { id: string }[];
  files?: Record<string, { name: string }[]>;
  deleteUserError?: { message?: string; status?: number } | null;
} = {}) {
  const deletes: { table: string; col: string; val: string | string[] }[] = [];
  const removed: string[] = [];
  let deleteUserCalledWith: string | null = null;

  const client: DeleteClient = {
    from: (table: string) => ({
      select: () => ({
        eq: async () => ({ data: opts.rounds ?? [] }),
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
