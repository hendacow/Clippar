// Check if Storage folders without matching shot rows correspond to valid rounds
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
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: rounds } = await supabase.from('rounds').select('id, course_id, status, created_at, clips_count').order('created_at', { ascending: false });
console.log(`Rounds in DB: ${rounds?.length}`);
console.log();

const { data: folders } = await supabase.storage.from('clips').list('', { limit: 1000 });
const folderSet = new Set(folders.map((f) => f.name));
console.log(`Storage folders: ${folderSet.size}\n`);

// For each round, cross-reference
const { data: shots } = await supabase.from('shots').select('round_id, clip_url');
const shotRoundIds = new Set(shots.map((s) => s.round_id));
const shotRoundsWithUrl = new Set(shots.filter((s) => s.clip_url && s.clip_url !== '').map((s) => s.round_id));

console.log('round_id          status       created      clips  hasShots  hasStorage  hasAnyUrl');
console.log('-'.repeat(100));
for (const r of rounds ?? []) {
  const hasShots = shotRoundIds.has(r.id);
  const hasStorage = folderSet.has(r.id);
  const hasUrl = shotRoundsWithUrl.has(r.id);
  console.log(
    `${r.id.slice(0, 8)}  ${(r.status ?? '').padEnd(12)} ${r.created_at.slice(0,10)}  ${String(r.clips_count ?? '').padEnd(5)}  ${hasShots ? ' Y' : ' N'}         ${hasStorage ? ' Y' : ' N'}          ${hasUrl ? ' Y' : ' N'}`,
  );
}

// Storage folders with no matching round
console.log();
console.log('Storage folders with NO matching round row:');
for (const f of folders) {
  const matching = (rounds ?? []).find((r) => r.id === f.name);
  if (!matching) {
    const { data: files } = await supabase.storage.from('clips').list(f.name, { limit: 3 });
    console.log(`  ${f.name}  (${files?.length ?? 0} files, e.g. ${files?.[0]?.name ?? '-'})`);
  }
}
