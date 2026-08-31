import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const api = readFileSync(join(root, 'lib/api.ts'), 'utf8');
const sub = readFileSync(join(root, 'lib/subscription.ts'), 'utf8');
const queue = readFileSync(join(root, 'lib/uploadQueue.ts'), 'utf8');

// Rule 1, made structural: a user's own already-uploaded footage is NEVER
// behind an entitlement. If this test fails, someone just built the lockout
// Henry forbade — a restored-phone user unable to reach their own clips.
test('the download path carries no subscription gate', () => {
  const signedUrls = api.slice(api.indexOf('export async function getSignedClipUrls'));
  const fn = signedUrls.slice(0, signedUrls.indexOf('\n}\n'));
  assert.doesNotMatch(fn, /isSubscribed|getProStatus|checkSubscription|entitlement/i);
  assert.doesNotMatch(api, /getProStatus|checkSubscription/, 'lib/api.ts as a whole is entitlement-free');
});

test('only the UPLOAD of new clips is entitlement-gated', () => {
  assert.match(queue, /getCloudBackupEffective/);
  assert.match(queue, /getProStatus/, 'the upload gate is real');
});

// The rules live at the code where a paywall would be built, not in a plan
// file someone would have to remember exists.
test('the entitlement rules are written into lib/subscription.ts', () => {
  assert.match(sub, /NEVER gate access to content a user already has/);
  assert.match(sub, /An app update never removes access/);
  assert.match(sub, /Early users get grandfathered/);
  assert.match(sub, /flag granted[\s\S]{0,20}once is unambiguous forever/);
});
