// Backfill clip_url for shots with empty string.
//
// Strategy:
// 1. List all rounds that have files in the `clips` Storage bucket
// 2. For each round, list all files matching `hole{N}_shot{M}_{localId}.mp4`
// 3. For each file, find the matching (round_id, hole_number, shot_number) shot
// 4. UPDATE shot.clip_url = `{round_id}/{filename}` (no "clips/" prefix)
//
// Dry-run by default. Pass `--apply` to actually write.
//
// Run: node scripts/backfill-clip-urls.mjs [--apply]

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

const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Matches `hole1_shot3_247.mp4`
const FILE_RE = /^hole(\d+)_shot(\d+)_\d+\.mp4$/i;

async function main() {
  console.log(`=== CLIP URL BACKFILL ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  // 1. Fetch all rounds that have at least one shot
  const { data: allShots, error: shotsErr } = await supabase
    .from('shots')
    .select('id, round_id, hole_number, shot_number, clip_url');

  if (shotsErr) { console.error(shotsErr); return; }

  const roundIds = [...new Set(allShots.map((s) => s.round_id))];
  console.log(`Rounds with shots: ${roundIds.length}`);

  // 2. List all folders in the Storage bucket
  const { data: roundFolders, error: listErr } = await supabase.storage
    .from('clips')
    .list('', { limit: 1000 });

  if (listErr) { console.error(listErr); return; }
  const storageRoundIds = new Set(roundFolders.map((r) => r.name));
  console.log(`Storage folders: ${storageRoundIds.size}\n`);

  let totalUpdates = 0;
  let totalSkipped = 0;
  let totalMissing = 0;
  let totalDupe = 0;
  const toApply = [];

  // 3. Process each round
  for (const roundId of roundIds) {
    if (!storageRoundIds.has(roundId)) {
      const missingShots = allShots.filter((s) => s.round_id === roundId);
      const missingEmptyCount = missingShots.filter((s) => !s.clip_url).length;
      if (missingEmptyCount > 0) {
        console.log(`  ⚠ round ${roundId.slice(0, 8)}: ${missingEmptyCount} empty shots, NO Storage folder → files gone`);
        totalMissing += missingEmptyCount;
      }
      continue;
    }

    const { data: files } = await supabase.storage
      .from('clips')
      .list(roundId, { limit: 1000 });

    if (!files || files.length === 0) continue;

    const shotsForRound = allShots.filter((s) => s.round_id === roundId);

    // Index shots by (hole, shot_number). If multiple rows exist for the
    // same key (dupes), prefer the one with empty clip_url (the orphan).
    const shotIndex = new Map();
    for (const shot of shotsForRound) {
      const key = `${shot.hole_number}:${shot.shot_number}`;
      const existing = shotIndex.get(key);
      if (!existing) {
        shotIndex.set(key, shot);
      } else {
        // Prefer the empty-string row
        if (!shot.clip_url && existing.clip_url) {
          shotIndex.set(key, shot);
        }
        totalDupe++;
      }
    }

    let updatedInRound = 0;
    for (const file of files) {
      const match = FILE_RE.exec(file.name);
      if (!match) continue;
      const hole = Number(match[1]);
      const shotNum = Number(match[2]);
      const key = `${hole}:${shotNum}`;
      const shot = shotIndex.get(key);
      if (!shot) {
        // Storage file with no matching shot row — orphan file
        continue;
      }
      if (shot.clip_url && shot.clip_url !== '') {
        // Already has a path — skip
        totalSkipped++;
        continue;
      }

      const newPath = `${roundId}/${file.name}`;
      toApply.push({ id: shot.id, clip_url: newPath });
      updatedInRound++;
      totalUpdates++;
    }

    if (updatedInRound > 0) {
      console.log(`  round ${roundId.slice(0, 8)}: ${updatedInRound} shots to update (${files.length} files in bucket)`);
    }
  }

  console.log();
  console.log(`=== SUMMARY ===`);
  console.log(`  Shots to update: ${totalUpdates}`);
  console.log(`  Already had clip_url (skipped): ${totalSkipped}`);
  console.log(`  Orphaned (no Storage folder): ${totalMissing}`);
  console.log(`  Duplicate (round,hole,shot) rows observed: ${totalDupe}`);
  console.log();

  if (!APPLY) {
    console.log('DRY RUN — no changes made. Pass --apply to execute.');
    return;
  }

  // 4. Apply updates in batches
  console.log('Applying updates...');
  let done = 0;
  for (const u of toApply) {
    const { error } = await supabase
      .from('shots')
      .update({ clip_url: u.clip_url })
      .eq('id', u.id);
    if (error) {
      console.error(`  ERROR for ${u.id}:`, error.message);
      continue;
    }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${toApply.length}`);
  }
  console.log(`✓ Updated ${done}/${toApply.length} shots`);
}

main().catch((e) => { console.error(e); process.exit(1); });
