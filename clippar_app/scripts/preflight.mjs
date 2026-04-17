// Pre-flight check for "new round + rebuild" scenario
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

const checks = [];

// 1. scores.par column exists?
const { data: score } = await supabase.from('scores').select('*').limit(1);
const scoreCols = Object.keys(score?.[0] ?? {});
checks.push({ name: 'scores.par column exists', ok: scoreCols.includes('par'), detail: scoreCols.includes('par') ? '' : 'Missing — saveScoreToSupabase will fail' });

// 2. rounds.reel_url column exists?
const { data: round } = await supabase.from('rounds').select('*').limit(1);
const roundCols = Object.keys(round?.[0] ?? {});
checks.push({ name: 'rounds.reel_url column', ok: roundCols.includes('reel_url') });
checks.push({ name: 'rounds.status column', ok: roundCols.includes('status') });

// 3. shots.clip_url column
const { data: shot } = await supabase.from('shots').select('*').limit(1);
const shotCols = Object.keys(shot?.[0] ?? {});
checks.push({ name: 'shots.clip_url column', ok: shotCols.includes('clip_url') });

// 4. clips bucket exists
const { data: buckets } = await supabase.storage.listBuckets();
const clipsBucket = buckets?.find((b) => b.name === 'clips');
checks.push({ name: 'clips Storage bucket', ok: !!clipsBucket });

// 5. reels are stored in clips bucket under clips/reels/?
const { data: reelFolder } = await supabase.storage.from('clips').list('reels', { limit: 5 });
checks.push({ name: 'reels folder present', ok: (reelFolder?.length ?? 0) > 0, detail: `${reelFolder?.length ?? 0} reels found` });

// 6. existing ready round with reel_url
const { data: readyRounds } = await supabase.from('rounds').select('id, reel_url, status').eq('status', 'ready').not('reel_url', 'is', null).limit(3);
checks.push({ name: 'rounds with reel_url present', ok: (readyRounds?.length ?? 0) > 0, detail: `${readyRounds?.length ?? 0} rounds have completed reels` });
if (readyRounds?.[0]) {
  // Test signing a reel
  const url = readyRounds[0].reel_url;
  const r = await fetch(url, { method: 'HEAD' }).catch(() => null);
  checks.push({ name: 'reel_url resolves (HEAD)', ok: r?.ok ?? false, detail: `${r?.status ?? 'fail'} for ${url?.slice(-50)}` });
}

// Print
console.log('=== PRE-FLIGHT ===\n');
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
}
console.log();
const failed = checks.filter((c) => !c.ok);
console.log(`${failed.length === 0 ? 'ALL OK' : `${failed.length} FAILED`}`);
