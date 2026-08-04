import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_BODY_LENGTH,
  describeRedeemResult,
  formatCodeForDisplay,
  formatRetryWait,
  interpretRedeemResponse,
  isCompleteCode,
  normalizeCodeInput,
} from '../lib/redeemCode';

// Pure half of the lifetime-code client (lib/redeemCode.ts): input
// normalisation, display grouping, and the wire→union mapping. All of it runs
// without a network, which is the point — the branches that matter here are
// the ones a manual test never reaches (429 with no body, a 2xx we can't
// parse, a code whose first four characters collide with the prefix).
//
// Reminder, because it is the whole security posture: none of this is a
// control. The server normalises and re-validates the code, and the server's
// rate limit is what stops brute force. These functions exist so a golfer
// reading a printed card is not punished for typing O instead of 0.

const BODY = '4T7Q9XKM2WRBJ5NH';
const PRINTED = 'CLIP-4T7Q-9XKM-2WRB-J5NH';

// ─── normalizeCodeInput ───

test('the printed form normalises to the bare 16-character body', () => {
  assert.equal(normalizeCodeInput(PRINTED), BODY);
  assert.equal(normalizeCodeInput(BODY), BODY);
});

test('lower case, stray spaces and stray dashes all normalise away', () => {
  assert.equal(normalizeCodeInput('clip-4t7q-9xkm-2wrb-j5nh'), BODY);
  assert.equal(normalizeCodeInput('  CLIP 4T7Q 9XKM 2WRB J5NH  '), BODY);
  assert.equal(normalizeCodeInput('CLIP--4T7Q--9XKM--2WRB--J5NH'), BODY);
  assert.equal(normalizeCodeInput('4T7Q 9XKM\t2WRB\nJ5NH'), BODY);
});

test('the classic misreads map instead of failing: I→1, L→1, O→0', () => {
  // Someone reading "1" off a card and typing "I" must still redeem.
  assert.equal(normalizeCodeInput('I'), '1');
  assert.equal(normalizeCodeInput('L'), '1');
  assert.equal(normalizeCodeInput('l'), '1');
  assert.equal(normalizeCodeInput('O'), '0');
  assert.equal(normalizeCodeInput('o'), '0');
  assert.equal(normalizeCodeInput('4T7QIL0O'), '4T7Q1100');
});

test('characters outside Crockford base32 are dropped, not kept', () => {
  // U is deliberately absent from the alphabet, so it can only be noise.
  assert.equal(normalizeCodeInput('4T7Q!@#$9XKM'), '4T7Q9XKM');
  assert.equal(normalizeCodeInput('4T7QU9XKM'), '4T7Q9XKM');
});

test('the CLIP prefix comes off BEFORE the confusion mapping', () => {
  // The regression this pins: L→1 and I→1 turn "CLIP" into "C11P", so a prefix
  // stripped after the mapping never matches and quietly becomes part of the
  // code — every prefixed code would hash to a 20-character string and never
  // redeem.
  assert.equal(normalizeCodeInput(PRINTED).length, CODE_BODY_LENGTH);
  assert.ok(!normalizeCodeInput(PRINTED).startsWith('C11P'));
});

test('a prefix that arrives already mapped ("C11P…") is still stripped', () => {
  assert.equal(normalizeCodeInput(`C11P-${BODY}`), BODY);
  assert.equal(normalizeCodeInput(`C11P${BODY}`), BODY);
});

test('a real body that happens to start C11P is never eaten', () => {
  // One in 32^4, and if we stripped it the code would be unredeemable forever.
  // Length is the disambiguator: a full-length body is a body, not a prefix.
  const collides = 'C11P4T7Q9XKM2WRB';
  assert.equal(collides.length, CODE_BODY_LENGTH);
  assert.equal(normalizeCodeInput(collides), collides);
  assert.equal(normalizeCodeInput('CLIP-C11P-4T7Q-9XKM-2WRB'), collides);
});

test('input past the code length is truncated, never wrapped or accepted', () => {
  assert.equal(normalizeCodeInput(`${BODY}ZZZZ`), BODY);
  assert.equal(normalizeCodeInput(`${PRINTED}-ZZZZ`), BODY);
});

test('empty and junk-only input normalise to empty, not to a prefix', () => {
  assert.equal(normalizeCodeInput(''), '');
  assert.equal(normalizeCodeInput('   '), '');
  assert.equal(normalizeCodeInput('----'), '');
  assert.equal(normalizeCodeInput('CLIP'), '');
  assert.equal(normalizeCodeInput('CLIP-'), '');
  assert.equal(normalizeCodeInput(undefined as unknown as string), '');
  assert.equal(normalizeCodeInput(null as unknown as string), '');
});

// ─── formatCodeForDisplay ───

test('a complete code displays as CLIP-XXXX-XXXX-XXXX-XXXX', () => {
  assert.equal(formatCodeForDisplay(BODY), PRINTED);
  assert.equal(formatCodeForDisplay('clip4t7q9xkm2wrbj5nh'), PRINTED);
});

test('formatting is idempotent, so it is safe as a controlled input value', () => {
  // Feeding the formatted value back through on every keystroke is exactly
  // what a controlled TextInput does; if this were not stable the field would
  // grow dashes without end.
  const once = formatCodeForDisplay(BODY);
  assert.equal(formatCodeForDisplay(once), once);
  assert.equal(formatCodeForDisplay(formatCodeForDisplay(once)), once);
});

test('groups appear as they are typed', () => {
  assert.equal(formatCodeForDisplay('4'), 'CLIP-4');
  assert.equal(formatCodeForDisplay('4T7Q'), 'CLIP-4T7Q');
  assert.equal(formatCodeForDisplay('4T7Q9'), 'CLIP-4T7Q-9');
  assert.equal(formatCodeForDisplay('4T7Q9XKM2WRB'), 'CLIP-4T7Q-9XKM-2WRB');
});

test('an empty field formats to empty, so backspace can clear it', () => {
  // Returning a bare "CLIP" here would make the field impossible to empty.
  assert.equal(formatCodeForDisplay(''), '');
  assert.equal(formatCodeForDisplay('CLIP-'), '');
});

test('isCompleteCode gates on the body length, prefix or not', () => {
  assert.equal(isCompleteCode(PRINTED), true);
  assert.equal(isCompleteCode(BODY), true);
  assert.equal(isCompleteCode('CLIP-4T7Q-9XKM-2WRB-J5N'), false);
  assert.equal(isCompleteCode(''), false);
});

// ─── formatRetryWait ───

test('retry waits read as plain English and always round up', () => {
  assert.equal(formatRetryWait(900), '15 minutes');
  assert.equal(formatRetryWait(45), '45 seconds');
  assert.equal(formatRetryWait(1), '1 second');
  assert.equal(formatRetryWait(60), '1 minute');
  assert.equal(formatRetryWait(61), '2 minutes');
  assert.equal(formatRetryWait(3600), '1 hour');
  assert.equal(formatRetryWait(7200), '2 hours');
  // Never "0 seconds" / "in -3 seconds" — that reads as "try now", which just
  // earns another 429.
  assert.equal(formatRetryWait(0), '1 second');
  assert.equal(formatRetryWait(-10), '1 second');
  assert.equal(formatRetryWait(Number.NaN), '15 minutes');
});

// ─── interpretRedeemResponse: the wire contract ───

test('200 ok:true grant:lifetime → redeemed', () => {
  assert.deepEqual(
    interpretRedeemResponse({ status: 200, body: { ok: true, grant: 'lifetime' } }),
    { status: 'redeemed', grant: 'lifetime', alreadyOwned: false }
  );
});

test('200 with alreadyOwned is an idempotent replay, not an error', () => {
  // The same user redeeming their own code twice must still land on Pro.
  assert.deepEqual(
    interpretRedeemResponse({
      status: 200,
      body: { ok: true, grant: 'lifetime', alreadyOwned: true },
    }),
    { status: 'redeemed', grant: 'lifetime', alreadyOwned: true }
  );
});

test('400 invalid / 400 malformed / 401 unauthorized / 500 server map straight through', () => {
  assert.deepEqual(interpretRedeemResponse({ status: 400, body: { ok: false, error: 'invalid' } }), {
    status: 'invalid',
  });
  assert.deepEqual(
    interpretRedeemResponse({ status: 400, body: { ok: false, error: 'malformed' } }),
    { status: 'malformed' }
  );
  assert.deepEqual(
    interpretRedeemResponse({ status: 401, body: { ok: false, error: 'unauthorized' } }),
    { status: 'unauthorized' }
  );
  assert.deepEqual(interpretRedeemResponse({ status: 500, body: { ok: false, error: 'server' } }), {
    status: 'server',
  });
});

test('429 carries the wait from the body, then the header, then the default', () => {
  assert.deepEqual(
    interpretRedeemResponse({
      status: 429,
      body: { ok: false, error: 'rate_limited', retryAfterSeconds: 900 },
    }),
    { status: 'rate_limited', retryAfterSeconds: 900 }
  );
  assert.deepEqual(
    interpretRedeemResponse({
      status: 429,
      body: { ok: false, error: 'rate_limited' },
      retryAfterHeader: '120',
    }),
    { status: 'rate_limited', retryAfterSeconds: 120 }
  );
  // No number anywhere: still a rate limit, still a stated wait. Silence here
  // would degrade to "something went wrong", which reads as a dead code.
  assert.deepEqual(
    interpretRedeemResponse({ status: 429, body: { ok: false, error: 'rate_limited' } }),
    { status: 'rate_limited', retryAfterSeconds: 900 }
  );
  // Garbage values must not produce "try again in NaN seconds".
  assert.deepEqual(
    interpretRedeemResponse({
      status: 429,
      body: { ok: false, error: 'rate_limited', retryAfterSeconds: -5 },
      retryAfterHeader: 'Wed, 21 Oct 2026 07:28:00 GMT',
    }),
    { status: 'rate_limited', retryAfterSeconds: 900 }
  );
});

test('a body that is a JSON string rather than an object still parses', () => {
  // Edge functions that answer without an application/json content-type come
  // back as text from supabase-js.
  assert.deepEqual(
    interpretRedeemResponse({ status: 400, body: '{"ok":false,"error":"invalid"}' }),
    { status: 'invalid' }
  );
});

test('a 2xx we cannot read is never a grant', () => {
  // Reporting Pro on the strength of a response we did not understand is the
  // one mistake that surfaces as a golfer who thinks he is unlocked and isn't.
  for (const body of [null, '', 'OK', '<html>gateway</html>', {}, { ok: true }, { ok: false }]) {
    assert.deepEqual(
      interpretRedeemResponse({ status: 200, body }),
      { status: 'server' },
      `2xx with body ${JSON.stringify(body)} must not read as a grant`
    );
  }
  // ...including an ok:true with a grant we do not recognise.
  assert.deepEqual(
    interpretRedeemResponse({ status: 200, body: { ok: true, grant: 'trial' } }),
    { status: 'server' }
  );
});

test('a bodiless failure falls back to the HTTP status', () => {
  // Proxies, gateways and cold-start 502s never speak our contract.
  assert.deepEqual(interpretRedeemResponse({ status: 429, body: '<html>429</html>' }), {
    status: 'rate_limited',
    retryAfterSeconds: 900,
  });
  assert.deepEqual(interpretRedeemResponse({ status: 401, body: null }), {
    status: 'unauthorized',
  });
  assert.deepEqual(interpretRedeemResponse({ status: 403, body: null }), {
    status: 'unauthorized',
  });
  assert.deepEqual(interpretRedeemResponse({ status: 400, body: null }), { status: 'invalid' });
  assert.deepEqual(interpretRedeemResponse({ status: 502, body: null }), { status: 'server' });
});

test('a 404 reads as a server problem, not as a bad code', () => {
  // 404 means the function is not deployed. Telling an ambassador their code
  // is invalid is how a perfectly good printed code gets thrown away.
  assert.deepEqual(interpretRedeemResponse({ status: 404, body: null }), { status: 'server' });
});

// ─── describeRedeemResult: the copy the golfer actually reads ───

test('rate-limited copy states the wait plainly and says the code survives', () => {
  const message = describeRedeemResult({ status: 'rate_limited', retryAfterSeconds: 900 });
  assert.equal(message.tone, 'error');
  assert.equal(message.headline, 'Too many attempts');
  assert.ok(
    message.detail.startsWith('Try again in 15 minutes.'),
    `expected a plain wait, got: ${message.detail}`
  );
  assert.match(message.detail, /has not been used up/);
});

test('both success flavours read as success', () => {
  assert.equal(
    describeRedeemResult({ status: 'redeemed', grant: 'lifetime', alreadyOwned: false }).tone,
    'success'
  );
  const replay = describeRedeemResult({
    status: 'redeemed',
    grant: 'lifetime',
    alreadyOwned: true,
  });
  assert.equal(replay.tone, 'success');
  assert.match(replay.detail, /still yours/);
});

test('every failure outcome has non-empty copy and no leaked internals', () => {
  const failures = [
    { status: 'invalid' },
    { status: 'malformed' },
    { status: 'unauthorized' },
    { status: 'server' },
    { status: 'network' },
    { status: 'rate_limited', retryAfterSeconds: 30 },
  ] as const;
  for (const result of failures) {
    const message = describeRedeemResult(result);
    assert.equal(message.tone, 'error', `${result.status} must render as an error`);
    assert.ok(message.headline.length > 0, `${result.status} has no headline`);
    assert.ok(message.detail.length > 0, `${result.status} has no detail`);
    // The 400 "invalid" case deliberately merges not-a-code / already-used /
    // revoked / expired server-side. The client must not re-split it in copy —
    // "already used by someone else" is an oracle for enumerating live codes.
    assert.doesNotMatch(message.detail, /revoked|expired|someone else/i);
  }
});

test('no copy anywhere claims a free trial', () => {
  // lib/iap.ts:ProOffering.trialDays only claims a trial the store actually
  // reported, because promising one to an ineligible lapsed subscriber charges
  // them immediately (App Review 3.1.2 + real money). This screen must not
  // reintroduce the claim through the back door.
  const all = [
    { status: 'redeemed', grant: 'lifetime', alreadyOwned: false },
    { status: 'redeemed', grant: 'lifetime', alreadyOwned: true },
    { status: 'invalid' },
    { status: 'malformed' },
    { status: 'unauthorized' },
    { status: 'server' },
    { status: 'network' },
    { status: 'rate_limited', retryAfterSeconds: 900 },
  ] as const;
  for (const result of all) {
    const message = describeRedeemResult(result);
    assert.doesNotMatch(`${message.headline} ${message.detail}`, /free trial|days free/i);
  }
});
