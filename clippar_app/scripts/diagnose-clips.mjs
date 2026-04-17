// Diagnose clip URL signing issue against real Supabase data.
// Confirms whether stored `clip_url` values double-prefix "clips/" and which
// form of the path actually returns a working signed URL.
//
// Run: node scripts/diagnose-clips.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  console.log('=== CLIPPAR CLIP DIAGNOSTIC ===');
  console.log('Supabase:', SUPABASE_URL);
  console.log();

  // 1. Fetch recent shots with clip_url set
  console.log('--- 1. Recent shots with clip_url ---');
  const { data: shots, error: shotsErr } = await supabase
    .from('shots')
    .select('id, round_id, hole_number, clip_url, created_at')
    .not('clip_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (shotsErr) {
    console.error('shots query error:', shotsErr);
    return;
  }
  console.log(`Found ${shots.length} shots with clip_url`);

  if (shots.length === 0) {
    console.log('No shots to test. Exiting.');
    return;
  }

  // Show sample paths
  console.log();
  console.log('Sample clip_url values:');
  for (const s of shots.slice(0, 8)) {
    console.log(`  [${s.created_at.slice(0, 10)}] hole ${pad(s.hole_number, 2)} → ${s.clip_url}`);
  }
  console.log();

  // 2. Tally prefixes
  const withPrefix = shots.filter((s) => s.clip_url.startsWith('clips/'));
  const withoutPrefix = shots.filter((s) => !s.clip_url.startsWith('clips/'));
  console.log(`Prefix analysis:`);
  console.log(`  clips/…  : ${withPrefix.length}`);
  console.log(`  (no prefix): ${withoutPrefix.length}`);
  console.log();

  // 3. List the clips bucket
  console.log('--- 2. Files in "clips" bucket (top-level round folders) ---');
  const { data: rounds, error: listErr } = await supabase.storage
    .from('clips')
    .list('', { limit: 20 });

  if (listErr) {
    console.error('list error:', listErr);
  } else {
    console.log(`Found ${rounds.length} top-level entries in bucket`);
    for (const r of rounds.slice(0, 5)) {
      console.log(`  ${r.name}`);
    }
  }
  console.log();

  // 4. Test signing each shot's clip_url BOTH ways
  console.log('--- 3. Signed URL test (HEAD each URL) ---');
  console.log(pad('stored path', 60), pad('raw', 8), pad('stripped', 8));
  console.log('-'.repeat(80));

  let rawWorks = 0;
  let strippedWorks = 0;
  let both404 = 0;

  for (const shot of shots.slice(0, 10)) {
    const raw = shot.clip_url;
    const stripped = raw.startsWith('clips/') ? raw.slice(6) : raw;

    // Try raw
    const { data: rawData } = await supabase.storage
      .from('clips')
      .createSignedUrl(raw, 60);
    let rawStatus = 'no-url';
    if (rawData?.signedUrl) {
      const r = await fetch(rawData.signedUrl, { method: 'HEAD' });
      rawStatus = String(r.status);
      if (r.ok) rawWorks++;
    }

    // Try stripped
    let strippedStatus = 'skip';
    if (stripped !== raw) {
      const { data: stripData } = await supabase.storage
        .from('clips')
        .createSignedUrl(stripped, 60);
      if (stripData?.signedUrl) {
        const r = await fetch(stripData.signedUrl, { method: 'HEAD' });
        strippedStatus = String(r.status);
        if (r.ok) strippedWorks++;
      } else {
        strippedStatus = 'no-url';
      }
    }

    if (rawStatus === '400' && (strippedStatus === '400' || strippedStatus === 'no-url' || strippedStatus === 'skip')) {
      both404++;
    }

    const displayPath = raw.length > 58 ? '...' + raw.slice(-55) : raw;
    console.log(pad(displayPath, 60), pad(rawStatus, 8), pad(strippedStatus, 8));
  }

  console.log();
  console.log('=== SUMMARY ===');
  console.log(`  Raw path worked:     ${rawWorks}/10`);
  console.log(`  Stripped path worked: ${strippedWorks}/10`);
  console.log(`  Both failed (orphaned): ${both404}/10`);
  console.log();

  if (strippedWorks > rawWorks) {
    console.log('✓ FIX CONFIRMED: Stripping "clips/" prefix resolves more URLs.');
    console.log('  The r2.ts + api.ts prefix-stripping fix is correct.');
  } else if (rawWorks > 0 && strippedWorks === 0) {
    console.log('⚠ UNEXPECTED: Raw paths work, stripped paths do not. Revisit fix.');
  } else if (both404 === 10) {
    console.log('⚠ All clips 404 either way — files missing from bucket entirely (orphaned shots).');
  } else {
    console.log('? Mixed results — review output above.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
