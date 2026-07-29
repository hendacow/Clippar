/**
 * Regression tests for the database authorisation surface (migration 017).
 *
 * These are the exploits from the 2026-07-29 audit, expressed as assertions
 * about the END STATE of the migration chain rather than about one file:
 *
 *   - any authenticated user could POST to /storage/v1/object/clips/<any key>
 *     (bucket-wide INSERT policy — another user's round folder, another user's
 *     reel key, unlimited 500 MB objects, and cloud backup for free)
 *   - any authenticated user could POST /rest/v1/hardware_orders with
 *     status='paid', amount_cents=0 — a forged payment record
 *   - PostgREST accepts a JSON array, so rounds/shots/courses/holes could each
 *     be filled thousands of rows at a time with no edge function in the path
 *
 * Migrations 001-016 are already applied to prod and must never be edited, so a
 * fix can only ever arrive as a LATER migration overriding an earlier one. That
 * is exactly why these tests replay every migration in order and assert on what
 * survives: asserting against 017 alone would not notice migration 018
 * re-opening the hole, which is the realistic way this regresses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

// ---------------------------------------------------------------------------
// A deliberately small SQL splitter. It only has to be right about the three
// things that hide a `;`: line comments, single-quoted literals, and
// dollar-quoted function bodies.
// ---------------------------------------------------------------------------
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        cur += sql[i++];
      }
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (sql[i] === "'") {
      cur += sql[i++];
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          cur += "''";
          i += 2;
          continue;
        }
        cur += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '"') {
      cur += sql[i++];
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        dollarTag = m[0];
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (sql[i] === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += sql[i++];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const normTable = (t: string) =>
  t.replace(/"/g, '').toLowerCase().replace(/^public\./, '');

type Privs = Set<string>;

interface SchemaState {
  /** `${table}|${policyName}` -> normalised statement text */
  policies: Map<string, string>;
  /** `${table}|${role}` -> table-wide privileges currently held */
  grants: Map<string, Privs>;
  /** `${table}|${triggerName}` -> normalised statement text */
  triggers: Map<string, string>;
  /** every statement that touches storage.buckets, in order */
  bucketStatements: string[];
}

/**
 * Replay every migration in filename order and return the resulting state.
 *
 * Supabase grants ALL on new tables in `public` to anon/authenticated by
 * default — that default is the whole reason migration 013 had to REVOKE before
 * re-granting per column — so every CREATE TABLE seeds those privileges here.
 * Without that, "authenticated cannot INSERT into hardware_orders" would pass
 * vacuously.
 */
function replayMigrations(): SchemaState {
  const state: SchemaState = {
    policies: new Map(),
    grants: new Map(),
    triggers: new Map(),
    bucketStatements: [],
  };

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  assert.ok(files.length >= 17, 'expected the full migration chain to be present');

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const raw of splitStatements(sql)) {
      const stmt = flat(raw);

      const created = /^CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+([A-Za-z0-9_."]+)/i.exec(stmt);
      if (created) {
        state.policies.set(`${normTable(created[2])}|${created[1]}`, stmt);
        continue;
      }
      const dropped = /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+([A-Za-z0-9_."]+)/i.exec(stmt);
      if (dropped) {
        state.policies.delete(`${normTable(dropped[2])}|${dropped[1]}`);
        continue;
      }

      const createTrigger = /^CREATE\s+TRIGGER\s+([A-Za-z0-9_]+)\s+(.+?)\s+ON\s+([A-Za-z0-9_."]+)/i.exec(stmt);
      if (createTrigger) {
        state.triggers.set(`${normTable(createTrigger[3])}|${createTrigger[1]}`, stmt);
        continue;
      }
      const dropTrigger = /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_."]+)/i.exec(stmt);
      if (dropTrigger) {
        state.triggers.delete(`${normTable(dropTrigger[2])}|${dropTrigger[1]}`);
        continue;
      }

      const createTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i.exec(stmt);
      if (createTable) {
        const t = normTable(createTable[1]);
        for (const role of ['anon', 'authenticated']) {
          state.grants.set(`${t}|${role}`, new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
        }
        continue;
      }

      // `ON FUNCTION` grants are a different namespace; ignore them here.
      const grant = /^GRANT\s+(.+?)\s+ON\s+(?!FUNCTION\b)(?:TABLE\s+)?([A-Za-z0-9_."]+)\s+TO\s+(.+)$/i.exec(stmt);
      if (grant) {
        applyPrivChange(state, grant[1], grant[2], grant[3], 'grant');
        continue;
      }
      const revoke = /^REVOKE\s+(.+?)\s+ON\s+(?!FUNCTION\b)(?:TABLE\s+)?([A-Za-z0-9_."]+)\s+FROM\s+(.+)$/i.exec(stmt);
      if (revoke) {
        applyPrivChange(state, revoke[1], revoke[2], revoke[3], 'revoke');
        continue;
      }

      if (/storage\.buckets/i.test(stmt)) state.bucketStatements.push(stmt);
    }
  }
  return state;
}

function applyPrivChange(
  state: SchemaState,
  privClause: string,
  table: string,
  roleClause: string,
  mode: 'grant' | 'revoke',
) {
  const t = normTable(table);
  const roles = roleClause.split(',').map((r) => r.trim().toLowerCase());
  // A column-scoped grant (`UPDATE (a, b)`) is NOT a table-wide privilege —
  // that distinction is the entire mechanism of the 013 profiles fix, so it
  // must not be flattened away.
  const columnScoped = /\(/.test(privClause);
  const privs = privClause
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  for (const role of roles) {
    const key = `${t}|${role}`;
    const set = state.grants.get(key) ?? new Set<string>();
    for (const p of privs) {
      const names = p === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [p];
      for (const n of names) {
        if (mode === 'revoke') set.delete(n);
        else if (!columnScoped) set.add(n);
      }
    }
    state.grants.set(key, set);
  }
}

const state = replayMigrations();
const has = (table: string, role: string, priv: string) =>
  state.grants.get(`${table}|${role}`)?.has(priv) ?? false;

// ---------------------------------------------------------------------------
// clips storage bucket
// ---------------------------------------------------------------------------
function clipsInsertPolicies(): string[] {
  return [...state.policies.entries()]
    .filter(([key, stmt]) => key.startsWith('storage.objects|') && /FOR\s+INSERT/i.test(stmt))
    .map(([, stmt]) => stmt);
}

test('attack: POST clips/<any-key> is no longer authorised by a bucket-wide INSERT policy', () => {
  const policies = clipsInsertPolicies();
  assert.equal(policies.length, 1, 'expected exactly one INSERT policy on storage.objects');
  const p = policies[0];

  // The exploit was `WITH CHECK (bucket_id = 'clips')` and nothing else.
  assert.doesNotMatch(
    p,
    /WITH\s+CHECK\s*\(\s*bucket_id\s*=\s*'clips'\s*\)/i,
    'clips INSERT is bucket-wide again — any user can write any key',
  );
  // Writing into a folder requires owning the round that names it.
  assert.match(p, /public\.rounds/i);
  assert.match(p, /auth\.uid\(\)/i);
});

test('attack: free account uploading raw clips is refused server-side', () => {
  // The Pro gate used to exist only in the client (storage-settings.tsx and
  // uploadQueue.ts), i.e. not at all.
  assert.match(clipsInsertPolicies()[0], /has_active_pro/i);
});

test('reel sharing stays free — the entitlement check must not cover reels/<roundId>.mp4', () => {
  // getShareUrl -> ensureReelUploaded uploads a reel for ANY user, so a policy
  // that gated the whole bucket on Pro would break sharing rather than secure
  // it. The reel branch must be reachable without has_active_pro().
  const p = clipsInsertPolicies()[0];
  const reelBranch = /'reels\/'\s*\|\|\s*r\.id::text\s*\|\|\s*'\.mp4'/i;
  assert.match(p, reelBranch);
  const beforeEntitlement = p.slice(0, p.search(/has_active_pro/i));
  assert.match(
    beforeEntitlement,
    reelBranch,
    'the reel branch must come before / outside the has_active_pro() branch',
  );
});

test('attack: unbounded object volume in the clips bucket is capped', () => {
  assert.match(clipsInsertPolicies()[0], /clips_quota_ok/i);

  // Per-object ceiling: the last word on storage.buckets must not restore a
  // 500 MB limit. A high ceiling only helps whoever wants to fill the bucket
  // in as few requests as possible.
  const sized = state.bucketStatements.filter((s) => /file_size_limit/i.test(s));
  assert.ok(sized.length > 0);
  const last = sized[sized.length - 1];
  const limits = (last.match(/\b\d{7,}\b/g) ?? []).map(Number);
  assert.ok(limits.length > 0, 'expected a byte limit literal');
  assert.ok(
    Math.min(...limits) <= 209715200,
    `clips per-object size limit regressed to ${Math.min(...limits)} bytes`,
  );
});

// ---------------------------------------------------------------------------
// hardware_orders
// ---------------------------------------------------------------------------
test('attack: client cannot insert a forged paid hardware order', () => {
  const insertPolicies = [...state.policies.entries()].filter(
    ([key, stmt]) => key.startsWith('hardware_orders|') && /FOR\s+INSERT/i.test(stmt),
  );
  assert.equal(insertPolicies.length, 0, 'hardware_orders has an INSERT policy again');

  // The policy was never the whole permission — the grant was.
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        has('hardware_orders', role, priv),
        false,
        `${role} still holds ${priv} on hardware_orders`,
      );
    }
  }
});

test('users keep read access to their own orders', () => {
  const selects = [...state.policies.entries()].filter(
    ([key, stmt]) => key.startsWith('hardware_orders|') && /FOR\s+SELECT/i.test(stmt),
  );
  assert.equal(selects.length, 1, 'app/profile/orders.tsx needs SELECT-own to survive');
  assert.match(selects[0][1], /auth\.uid\(\)\s*=\s*user_id/i);
});

// ---------------------------------------------------------------------------
// Bulk-insert volume caps
// ---------------------------------------------------------------------------
for (const table of ['rounds', 'shots', 'courses', 'holes']) {
  test(`attack: bulk INSERT array into ${table} hits a server-side cap`, () => {
    const triggers = [...state.triggers.entries()].filter(
      ([key, stmt]) => key.startsWith(`${table}|`) && /BEFORE\s+INSERT/i.test(stmt),
    );
    assert.ok(
      triggers.length >= 1,
      `${table} has no BEFORE INSERT cap trigger — a JSON array on /rest/v1/${table} is unbounded again`,
    );
  });
}

test('shared-catalog inserts are attributable', () => {
  // Junk rows in `courses` are visible to every user via searchCourses; without
  // an owner column there is no way to find or sweep one account's writes.
  const sql = readFileSync(join(MIGRATIONS_DIR, '017_authz_hardening.sql'), 'utf8');
  assert.match(sql, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+submitted_by/i);
  assert.match(sql, /NEW\.submitted_by\s*:=\s*v_uid/i);
});

// ---------------------------------------------------------------------------
// Previously-fixed findings (migration 013) — confirm 014-017 did not undo them
// ---------------------------------------------------------------------------
test('billing columns on profiles are still not client-writable', () => {
  assert.equal(has('profiles', 'authenticated', 'UPDATE'), false);
  assert.equal(has('profiles', 'anon', 'UPDATE'), false);
});

test('rounds.dispatch_claimed_at is still not client-writable', () => {
  assert.equal(has('rounds', 'authenticated', 'UPDATE'), false);
});
