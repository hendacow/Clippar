import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBMIT = join(REPO, 'clippar-web', 'api', 'submit.py');
const src = readFileSync(SUBMIT, 'utf8');
// The explanatory comments necessarily quote the old code, so checks that count
// occurrences run against the code alone.
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/**
 * clippar-web/api/submit.py is the public waitlist endpoint: unauthenticated, no
 * CAPTCHA, and a honeypot that a script defeats by simply not sending the
 * "website" field. Each accepted request used to open a fresh Neon connection
 * and create a Sender.net subscriber from an attacker-chosen address, both
 * uncapped — Neon connection exhaustion, a blown subscriber quota, and (with a
 * welcome automation on the group) an email-bomb relay from Clippar's sending
 * domain.
 *
 * There is no Python test runner in this repo, so these are structural: they
 * assert the controls exist AND are invoked on the request path, which is the
 * specific failure mode worth guarding — a limiter that is defined and never
 * called reads as protection while the endpoint stays open.
 */

const at = (needle: string) => {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `submit.py no longer contains ${needle}`);
  return i;
};

test('the waitlist endpoint declares a per-IP and a project-wide limit', () => {
  assert.match(src, /^PER_IP_LIMIT\s*=\s*\d+/m);
  assert.match(src, /^GLOBAL_LIMIT\s*=\s*\d+/m);
});

test('both limits are actually consumed on the request path', () => {
  const calls = [...src.matchAll(/_consume_rate_limit\(\s*conn,/g)];
  assert.ok(
    calls.length >= 2,
    'expected the per-IP and project-wide counters to both be consumed, ' +
      `found ${calls.length} call site(s)`,
  );
  assert.ok(
    src.includes('_client_ip(self.headers)'),
    'the per-IP counter must be keyed by the client IP',
  );
});

test('the limiter runs BEFORE the insert and before Sender.net', () => {
  const limit = at('_consume_rate_limit(');
  const insert = at('INSERT INTO waitlist (name, email, frequency)');
  const sender = at('_add_to_sender(email, name, frequency)');
  assert.ok(limit < insert, 'rate limit must be consumed before the row is written');
  assert.ok(
    limit < sender,
    'rate limit must be consumed before a subscriber is created at a third party',
  );
});

test('the counter is incremented and read in one atomic statement', () => {
  // SELECT-then-UPDATE races: fire 200 concurrent requests and every one reads
  // the same pre-increment value, so the cap is not a cap.
  assert.ok(
    src.includes('ON CONFLICT (subject) DO UPDATE'),
    'the counter must use INSERT ... ON CONFLICT DO UPDATE ... RETURNING',
  );
  assert.ok(src.includes('RETURNING count'), 'the new count must be read back atomically');
});

test('a rejected request answers 429 with Retry-After', () => {
  assert.match(src, /self\._send_json\(\s*\n?\s*429,/);
  assert.ok(
    src.includes('self.send_header("Retry-After"'),
    'a 429 without Retry-After makes well-behaved clients retry in lockstep',
  );
});

test('the database connection is reused across warm invocations', () => {
  // psycopg2.connect() per request meant one Neon connection per concurrent
  // autoscaled invocation, with no pooling.
  assert.ok(code.includes('global _conn'), 'the connection must be module-level and reused');
  const connectCalls = [...code.matchAll(/psycopg2\.connect\(/g)];
  assert.equal(
    connectCalls.length,
    1,
    'psycopg2.connect() should appear exactly once, inside the reuse helper',
  );
  // `_conn.close()` inside the reuse helper (discarding a dead connection) is
  // fine; a bare `conn.close()` on the request path is the bug.
  assert.ok(
    !/\bconn\.close\(\)/.test(code.replace(/_conn\.close\(\)/g, '')),
    'the request path must not close the shared connection',
  );
});

test('SQL still uses bound parameters, never string interpolation', () => {
  assert.ok(!/execute\(\s*f"/.test(src), 'no f-string SQL');
  assert.ok(!/execute\([^)]*%\s*\(/.test(src), 'no %-formatted SQL');
});
