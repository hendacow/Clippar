#!/usr/bin/env node
/**
 * Build-time endpoint guard. Invoked from the `prebuildCommand` of the
 * production / preview / staging profiles in eas.json, so it runs BEFORE any
 * native project is generated and fails the build rather than shipping.
 *
 * WHY
 * Spec 5.11 "Environment confusion": a production build must fail if a
 * non-production endpoint is selected. Nothing enforced that. constants/config.ts
 * reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_PIPELINE_URL /
 * EXPO_PUBLIC_CONCAT_URL with a bare `!` and validates none of them, and the
 * `preview` profile shipped an internal build pointed at the PRODUCTION Supabase
 * project with the production bundle id. A binary that talks to a dev tunnel, an
 * ngrok host or the wrong Supabase project is a data-integrity and data-exposure
 * problem that no amount of runtime checking can undo once it is on a device.
 *
 * WHAT IT DOES AND DOES NOT FAIL ON
 * It hard-fails on a value that is present and WRONG — a local/dev/tunnel host
 * anywhere, or a `production` profile pointed at a Supabase project that is not
 * the production one. It warns, loudly, on a value that is MISSING: an absent
 * EXPO_PUBLIC_SUPABASE_URL already crashes the app on first launch (createClient
 * throws "supabaseUrl is required"), so it cannot ship silently, and failing the
 * release build on an env-plumbing quirk would be a worse failure than the one
 * being prevented. Wrong is the security bug; missing is a loud bug.
 */

const PROD_SUPABASE_REF = 'xdefwnqyjffgclzqmvax';

// Hosts that must never appear in ANY EAS-built binary. `-dev`/`-staging` are
// deliberately absent from this list: the staging and preview profiles are
// SUPPOSED to point at the non-production project.
const NON_PRODUCTION_HOST =
  /(localhost|127\.0\.0\.1|0\.0\.0\.0|\bngrok\b|\.ngrok\b|\.local\b|:19000|:8081)/i;

const URL_VARS = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_PIPELINE_URL',
  'EXPO_PUBLIC_CONCAT_URL',
];

const profile = process.env.EAS_BUILD_PROFILE || process.env.BUILD_PROFILE || '';
const errors = [];
const warnings = [];

for (const name of URL_VARS) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    warnings.push(`${name} is empty at prebuild time`);
    continue;
  }
  if (NON_PRODUCTION_HOST.test(value)) {
    errors.push(`${name} points at a non-production host: ${value}`);
  }
}

// The production profile builds the App Store binary. It must talk to the
// production Supabase project and nothing else — a store build wired to the dev
// project writes real users' rounds into a database that gets reset.
if (profile === 'production') {
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
  if (supabaseUrl && !supabaseUrl.includes(PROD_SUPABASE_REF)) {
    errors.push(
      `production build has EXPO_PUBLIC_SUPABASE_URL=${supabaseUrl}, which is ` +
        `not the production project (${PROD_SUPABASE_REF})`,
    );
  }
}

// Conversely, a non-store profile must NOT be wired to production. This is the
// `preview` regression: distribution:internal, environment:production, no
// APP_VARIANT — an unreviewed build with the store app's identity writing into
// the production dataset and receiving an automatic OTA on every push to main.
if (profile === 'preview' || profile === 'staging' || profile.startsWith('development')) {
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
  if (supabaseUrl.includes(PROD_SUPABASE_REF)) {
    errors.push(
      `"${profile}" is a non-store profile but EXPO_PUBLIC_SUPABASE_URL points ` +
        `at the PRODUCTION project (${PROD_SUPABASE_REF})`,
    );
  }
}

const label = profile ? `profile "${profile}"` : 'build';
for (const w of warnings) console.warn(`[verify-build-env] WARN  ${w}`);

if (errors.length > 0) {
  console.error(`\n[verify-build-env] REFUSING to build ${label}:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`[verify-build-env] OK  endpoints acceptable for ${label}`);
