#!/usr/bin/env npx tsx
/**
 * Course Sync Script
 *
 * Triggers the sync-courses Edge Function to fetch course data from
 * external APIs and populate the Supabase database.
 *
 * Usage:
 *   npx tsx scripts/sync-courses.ts                    # sync QLD region
 *   npx tsx scripts/sync-courses.ts --single "Royal Queensland"  # sync one course
 *   npx tsx scripts/sync-courses.ts --state NSW        # sync a different state
 *
 * Requires .env.local with EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 */

import * as fs from 'fs';
import * as path from 'path';

// Load env from .env.local
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const singleIdx = args.indexOf('--single');
  const stateIdx = args.indexOf('--state');

  let body: Record<string, unknown>;

  if (singleIdx >= 0 && args[singleIdx + 1]) {
    body = {
      action: 'sync_single',
      name: args[singleIdx + 1],
      country: 'AU',
    };
    console.log(`Syncing single course: "${args[singleIdx + 1]}"...`);
  } else {
    const state = stateIdx >= 0 && args[stateIdx + 1] ? args[stateIdx + 1] : 'QLD';
    body = {
      action: 'sync_region',
      country: 'AU',
      state,
    };
    console.log(`Syncing region: ${state}, AU...`);
  }

  const url = `${SUPABASE_URL}/functions/v1/sync-courses`;
  console.log(`POST ${url}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (res.ok) {
      console.log('Success:', JSON.stringify(data, null, 2));
    } else {
      console.error(`Error ${res.status}:`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error('Request failed:', err);
    process.exit(1);
  }
}

main();
