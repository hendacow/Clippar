// Inspect shots table schema + constraints
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
  // Sample shot to see columns
  const { data: sample } = await supabase.from('shots').select('*').limit(1);
  console.log('shots columns:', Object.keys(sample?.[0] ?? {}));
  console.log();
  console.log('sample row:', JSON.stringify(sample?.[0], null, 2));
  console.log();

  {
    const { data: all } = await supabase
      .from('shots')
      .select('round_id, hole_number, shot_number, clip_url, created_at')
      .order('round_id');
    const counts = new Map();
    for (const s of all ?? []) {
      const k = `${s.round_id}:${s.hole_number}:${s.shot_number}`;
      if (!counts.has(k)) counts.set(k, []);
      counts.get(k).push(s);
    }
    const dupesArr = [...counts.entries()].filter(([, v]) => v.length > 1);
    console.log(`Total unique (round,hole,shot) combos: ${counts.size}`);
    console.log(`Duplicates: ${dupesArr.length}`);
    if (dupesArr.length > 0) {
      console.log('Sample dupes:');
      for (const [k, v] of dupesArr.slice(0, 5)) {
        console.log(`  ${k}:`);
        for (const row of v) {
          console.log(`    clip_url="${row.clip_url}" created=${row.created_at}`);
        }
      }
    }

    // Also count non-empty clip_urls per round
    const roundStats = new Map();
    for (const s of all ?? []) {
      if (!roundStats.has(s.round_id)) roundStats.set(s.round_id, { total: 0, withUrl: 0 });
      const st = roundStats.get(s.round_id);
      st.total++;
      if (s.clip_url && s.clip_url !== '') st.withUrl++;
    }
    console.log();
    console.log(`Rounds with shots: ${roundStats.size}`);
    const roundsWithAnyUrl = [...roundStats.values()].filter((r) => r.withUrl > 0).length;
    console.log(`Rounds where at least 1 shot has clip_url: ${roundsWithAnyUrl}`);
  }

  // List one round's files in Storage to see pattern
  console.log();
  console.log('--- Storage pattern inspection ---');
  const { data: rounds } = await supabase.storage.from('clips').list('', { limit: 5 });
  for (const r of (rounds ?? []).slice(0, 3)) {
    const { data: files } = await supabase.storage.from('clips').list(r.name, { limit: 50 });
    console.log(`\nclips/${r.name}/  (${files?.length ?? 0} files)`);
    for (const f of (files ?? []).slice(0, 5)) {
      console.log(`  ${f.name}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
