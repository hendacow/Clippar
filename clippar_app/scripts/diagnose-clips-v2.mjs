// Deeper diagnostic — find shots with NON-EMPTY clip_url
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; }),
);

const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  // All shots
  const { count: totalShots } = await supabase.from('shots').select('*', { count: 'exact', head: true });
  console.log(`Total shots in DB: ${totalShots}`);

  // Shots with non-null clip_url
  const { count: nonNull } = await supabase.from('shots').select('*', { count: 'exact', head: true }).not('clip_url', 'is', null);
  console.log(`Shots with clip_url not null: ${nonNull}`);

  // Shots with non-empty clip_url
  const { count: nonEmpty } = await supabase.from('shots').select('*', { count: 'exact', head: true }).neq('clip_url', '');
  console.log(`Shots with clip_url != '': ${nonEmpty}`);
  console.log();

  // Get shots with real paths
  const { data: realShots, error } = await supabase
    .from('shots')
    .select('id, round_id, hole_number, clip_url, created_at')
    .not('clip_url', 'is', null)
    .neq('clip_url', '')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) { console.error(error); return; }
  console.log(`Shots with NON-EMPTY clip_url: ${realShots.length}`);
  console.log();

  if (realShots.length === 0) {
    console.log('⚠ CRITICAL: Zero shots in DB have real clip_url values!');
    console.log('  All shots have empty string "" as clip_url, which is NOT NULL.');
    console.log('  This means uploads are completing but clip_url is never being persisted.');
    console.log();

    // Check: do any rounds have clips in Storage for them?
    console.log('--- Checking Storage for actual clip files ---');
    const { data: rounds } = await supabase.storage.from('clips').list('', { limit: 5 });
    for (const r of (rounds ?? [])) {
      const { data: files } = await supabase.storage.from('clips').list(r.name, { limit: 5 });
      console.log(`  clips/${r.name}/: ${files?.length ?? 0} files`);
      if (files?.[0]) console.log(`    e.g. ${files[0].name}`);
    }
    return;
  }

  // Show what formats exist
  const prefixed = realShots.filter((s) => s.clip_url.startsWith('clips/'));
  const notPrefixed = realShots.filter((s) => !s.clip_url.startsWith('clips/'));
  console.log(`  With "clips/" prefix: ${prefixed.length}`);
  console.log(`  Without prefix:       ${notPrefixed.length}`);
  console.log();

  // Sample each
  console.log('Sample with prefix:');
  prefixed.slice(0, 3).forEach((s) => console.log(`  ${s.clip_url}`));
  console.log('Sample without prefix:');
  notPrefixed.slice(0, 3).forEach((s) => console.log(`  ${s.clip_url}`));
  console.log();

  // Sign each
  console.log('--- Signing tests ---');
  for (const shot of realShots.slice(0, 8)) {
    const raw = shot.clip_url;
    const stripped = raw.startsWith('clips/') ? raw.slice(6) : raw;

    const { data: rawD } = await supabase.storage.from('clips').createSignedUrl(raw, 60);
    const { data: stripD } = raw !== stripped
      ? await supabase.storage.from('clips').createSignedUrl(stripped, 60)
      : { data: null };

    let rawStatus = 'no-url';
    if (rawD?.signedUrl) {
      const r = await fetch(rawD.signedUrl, { method: 'HEAD' });
      rawStatus = `${r.status}${r.ok ? ' ✓' : ''}`;
    }

    let stripStatus = 'skip';
    if (stripD?.signedUrl) {
      const r = await fetch(stripD.signedUrl, { method: 'HEAD' });
      stripStatus = `${r.status}${r.ok ? ' ✓' : ''}`;
    }

    console.log(`  ${raw.slice(-50).padEnd(52)} raw=${rawStatus.padEnd(8)} stripped=${stripStatus}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
