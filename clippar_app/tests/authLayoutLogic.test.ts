import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authContentJustify } from '../lib/authLayoutLogic';

// The auth screens must center content when it fits but top-align (so the logo
// stays below the Dynamic Island and reachable) when content overflows the
// viewport. Lock the decision function so the clipping regression can't return.

test('content fits viewport → center', () => {
  assert.equal(authContentJustify(500, 800), 'center');
});

test('content exactly equals viewport → center', () => {
  assert.equal(authContentJustify(800, 800), 'center');
});

test('content taller than viewport (signup, small screen) → top-align', () => {
  assert.equal(authContentJustify(900, 800), 'flex-start');
});

test('unmeasured content height → center (first-paint default)', () => {
  assert.equal(authContentJustify(0, 800), 'center');
});

test('unmeasured viewport height → center (first-paint default)', () => {
  assert.equal(authContentJustify(900, 0), 'center');
});

test('both unmeasured → center', () => {
  assert.equal(authContentJustify(0, 0), 'center');
});
