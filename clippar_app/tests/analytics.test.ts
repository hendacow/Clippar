import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_EVENTS,
  buildCaptureEvent,
  buildIdentifyEvent,
} from '../lib/analyticsPayload';

// Pure payload builders for the PostHog ingest proxy. The RN transport
// (distinct_id storage, batching, fetch) lives in lib/analytics.ts and can't
// run headlessly; the payload SHAPE — which is what PostHog actually parses —
// is pure and locked down here.

const BASE = { $lib: 'clippar-mobile', platform: 'ios' };
const TS = '2026-06-23T00:00:00.000Z';

test('event name constants are the documented funnel set', () => {
  assert.deepEqual(Object.values(ANALYTICS_EVENTS).sort(), [
    'app_opened',
    'paywall_viewed',
    'reel_created',
    'round_started',
    'signed_up',
    'subscription_started',
  ]);
});

test('buildCaptureEvent: merges base + custom props and nests distinct_id', () => {
  const ev = buildCaptureEvent(
    ANALYTICS_EVENTS.ROUND_STARTED,
    'anon-123',
    { holes_played: 18 },
    BASE,
    TS,
  );
  assert.equal(ev.event, 'round_started');
  assert.equal(ev.timestamp, TS);
  assert.equal(ev.properties.distinct_id, 'anon-123');
  assert.equal(ev.properties.holes_played, 18);
  assert.equal(ev.properties.$lib, 'clippar-mobile');
});

test('buildCaptureEvent: distinct_id cannot be clobbered by custom props', () => {
  const ev = buildCaptureEvent(
    'x',
    'real-id',
    { distinct_id: 'spoofed', platform: 'android' },
    BASE,
    TS,
  );
  // Identity wins; other base props are still overridable by callers.
  assert.equal(ev.properties.distinct_id, 'real-id');
  assert.equal(ev.properties.platform, 'android');
});

test('buildCaptureEvent: undefined properties is safe', () => {
  const ev = buildCaptureEvent('x', 'id', undefined, BASE, TS);
  assert.equal(ev.properties.distinct_id, 'id');
});

test('buildIdentifyEvent: sets $anon_distinct_id when anon differs from user', () => {
  const ev = buildIdentifyEvent('user-1', 'anon-9', { email: 'a@b.com' }, BASE, TS);
  assert.equal(ev.event, '$identify');
  assert.equal(ev.properties.distinct_id, 'user-1');
  assert.equal(ev.properties.$anon_distinct_id, 'anon-9');
  assert.deepEqual(ev.properties.$set, { email: 'a@b.com' });
});

test('buildIdentifyEvent: omits $anon_distinct_id when ids match or anon is null', () => {
  const same = buildIdentifyEvent('user-1', 'user-1', undefined, BASE, TS);
  assert.ok(!('$anon_distinct_id' in same.properties));
  assert.deepEqual(same.properties.$set, {});

  const noAnon = buildIdentifyEvent('user-1', null, undefined, BASE, TS);
  assert.ok(!('$anon_distinct_id' in noAnon.properties));
});
