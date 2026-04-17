// Delete duplicate shot rows where one has an empty clip_url and another has a real one.
// Keeps the row with the real clip_url.
//
// Run: node scripts/dedupe-shots.mjs [--apply]

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const APPLY = process.argv.includes('--apply');

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dirname, '..', '.env.local'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; }),
);
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: all } = await supabase
  .from('shots')
  .select('id, round_id, hole_number, shot_number, clip_url, created_at')
  .order('created_at');

const groups = new Map();
for (const s of all) {
  const k = `${s.round_id}:${s.hole_number}:${s.shot_number}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(s);
}

const toDelete = [];
for (const [k, rows] of groups) {
  if (rows.length < 2) continue;
  const withUrl = rows.filter((r) => r.clip_url && r.clip_url !== '');
  const empty = rows.filter((r) => !r.clip_url || r.clip_url === '');
  if (withUrl.length > 0 && empty.length > 0) {
    // Keep the one with URL, delete the empty ones
    for (const e of empty) {
      toDelete.push(e.id);
      console.log(`  will delete empty dupe: ${e.id.slice(0,8)}  ${k}`);
    }
  }
}

console.log(`\n${toDelete.length} rows to delete ${APPLY ? '' : '(DRY RUN — pass --apply to execute)'}`);

if (APPLY && toDelete.length > 0) {
  const { error } = await supabase.from('shots').delete().in('id', toDelete);
  if (error) console.error(error);
  else console.log(`✓ Deleted ${toDelete.length} duplicate shots`);
}
