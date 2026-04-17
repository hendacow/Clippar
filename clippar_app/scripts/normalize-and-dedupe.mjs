// 1. Normalize clip_urls: strip "clips/" prefix
// 2. Delete duplicate rows (same round_id, hole, shot_number) keeping newest
//
// Run: node scripts/normalize-and-dedupe.mjs [--apply]

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

console.log(`=== NORMALIZE & DEDUPE ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

// Step 1: Normalize clips/ prefix
const { data: prefixed } = await supabase
  .from('shots')
  .select('id, clip_url')
  .like('clip_url', 'clips/%');

console.log(`Shots with "clips/" prefix: ${prefixed?.length ?? 0}`);
for (const s of prefixed ?? []) {
  const stripped = s.clip_url.slice(6);
  console.log(`  ${s.id.slice(0,8)}: ${s.clip_url} → ${stripped}`);
  if (APPLY) {
    await supabase.from('shots').update({ clip_url: stripped }).eq('id', s.id);
  }
}

// Step 2: Find duplicates
const { data: all } = await supabase
  .from('shots')
  .select('id, round_id, hole_number, shot_number, clip_url, created_at')
  .order('round_id')
  .order('hole_number')
  .order('shot_number')
  .order('created_at');

const groups = new Map();
for (const s of all ?? []) {
  const k = `${s.round_id}:${s.hole_number}:${s.shot_number}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(s);
}

const toDelete = [];
for (const [k, rows] of groups) {
  if (rows.length < 2) continue;

  // Re-sort: prefer rows with real clip_url over empty string
  rows.sort((a, b) => {
    const aHasUrl = a.clip_url && a.clip_url !== '';
    const bHasUrl = b.clip_url && b.clip_url !== '';
    if (aHasUrl && !bHasUrl) return -1;
    if (!aHasUrl && bHasUrl) return 1;
    // Tie-break: newest wins
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // Keep rows[0], delete the rest
  for (const dup of rows.slice(1)) {
    toDelete.push(dup.id);
    console.log(`  will delete: ${dup.id.slice(0,8)} (${k}, clip_url="${dup.clip_url}")`);
  }
}

console.log(`\n${toDelete.length} duplicate rows to delete`);

if (APPLY && toDelete.length > 0) {
  // Delete in chunks of 100
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100);
    const { error } = await supabase.from('shots').delete().in('id', chunk);
    if (error) { console.error(error); break; }
  }
  console.log(`✓ Deleted ${toDelete.length} duplicates`);
}
