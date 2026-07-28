import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appConfig = require('../app.config.js') as () => any;

// PRIV-001. The manifest shipped with NSPrivacyCollectedDataTypes: [] while the
// binary sent email, precise per-shot GPS, video, crash/perf traces and
// purchase state off-device. A manifest that is present but false is worse than
// an absent one — Apple reconciles it against observed SDK/network behaviour,
// and it is mirrored into the App Store privacy answers. This test fails the
// build if the array is ever emptied again, or if a declared type loses its
// shape.

const manifest = appConfig().expo.ios.privacyManifests;
const collected = manifest.NSPrivacyCollectedDataTypes as any[];

const REQUIRED = [
  // Supabase Auth account identity.
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeUserID',
  // Per-shot GPS: local_clips.gps_latitude/longitude → shots table.
  'NSPrivacyCollectedDataTypePreciseLocation',
  // Clip and reel uploads, including each video's audio track.
  'NSPrivacyCollectedDataTypePhotosorVideos',
  // RevenueCat / StoreKit / Stripe.
  'NSPrivacyCollectedDataTypePurchaseHistory',
  // Sentry.
  'NSPrivacyCollectedDataTypeCrashData',
  'NSPrivacyCollectedDataTypePerformanceData',
];

test('privacy manifest declares every data type the app actually collects', () => {
  assert.ok(Array.isArray(collected));
  assert.notEqual(
    collected.length,
    0,
    'NSPrivacyCollectedDataTypes must not be empty — the app collects data'
  );
  const declared = collected.map((e) => e.NSPrivacyCollectedDataType);
  for (const type of REQUIRED) {
    assert.ok(declared.includes(type), `missing declaration: ${type}`);
  }
});

test('every declared type is well-formed and non-tracking', () => {
  const VALID_PURPOSES = new Set([
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
    'NSPrivacyCollectedDataTypePurposeAnalytics',
    'NSPrivacyCollectedDataTypePurposeProductPersonalization',
    'NSPrivacyCollectedDataTypePurposeAppFunctionalityOther',
    'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
    'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
    'NSPrivacyCollectedDataTypePurposeOther',
  ]);
  for (const entry of collected) {
    const name = entry.NSPrivacyCollectedDataType;
    assert.equal(typeof entry.NSPrivacyCollectedDataTypeLinked, 'boolean', name);
    assert.equal(typeof entry.NSPrivacyCollectedDataTypeTracking, 'boolean', name);
    // Everything is tied to the signed-in account, and none of it feeds
    // cross-app tracking — which is what lets NSPrivacyTracking stay false.
    assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true, `${name} is account-linked`);
    assert.equal(entry.NSPrivacyCollectedDataTypeTracking, false, `${name} is not tracking`);
    const purposes = entry.NSPrivacyCollectedDataTypePurposes;
    assert.ok(Array.isArray(purposes) && purposes.length > 0, `${name} needs a purpose`);
    for (const p of purposes) {
      assert.ok(VALID_PURPOSES.has(p), `${name} has unknown purpose ${p}`);
    }
  }
});

test('no data type claims tracking while NSPrivacyTracking is false', () => {
  // These two must agree, or Apple rejects the manifest outright.
  if (manifest.NSPrivacyTracking === false) {
    assert.equal(
      collected.some((e) => e.NSPrivacyCollectedDataTypeTracking === true),
      false
    );
    assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
  }
});
