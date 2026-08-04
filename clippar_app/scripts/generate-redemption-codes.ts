#!/usr/bin/env npx tsx
/**
 * generate-redemption-codes — mint lifetime Clippar Pro codes.
 *
 * Run from clippar_app/ :
 *
 *   npx tsx scripts/generate-redemption-codes.ts --count 10 --label "Ambassadors Aug 2026"
 *   npx tsx scripts/generate-redemption-codes.ts --count 1 --label "Sam" --expires-days 90
 *
 * Environment (both REQUIRED; .env.local is read as a fallback, as with
 * scripts/sync-courses.ts):
 *   EXPO_PUBLIC_SUPABASE_URL / SUPABASE_URL   the project to write to
 *   SUPABASE_SERVICE_ROLE_KEY                 redemption_codes is service-role only
 *   REDEMPTION_CODE_PEPPER                    the HMAC key; must be the SAME value
 *                                             as the deployed function's secret
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * It prints the plaintext codes to stdout ONCE and inserts only their HMACs.
 * There is no --output flag and nothing here writes a file, because a file of
 * live redemption codes is a file of free subscriptions: it gets synced,
 * backed up, attached to a message, and found. The codes are unrecoverable the
 * moment the terminal is closed — that is the design working, not a bug. If a
 * card is lost, revoke the row (set revoked_at) and mint a new one.
 *
 * The hashing and normalisation are imported, not reimplemented. Generator and
 * verifier must agree byte for byte or every printed card is dead on arrival,
 * and the two never compare notes at runtime — see
 * supabase/functions/redeem-code/codeFormat.ts.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  bytesToCode,
  CODE_ENTROPY_BYTES,
  formatCodeForDisplay,
  hashCode,
  isWellFormedCode,
  normalizeCode,
  // Extensionless on purpose. Deno requires the `.ts` suffix and the edge
  // function imports it that way; the app's tsconfig does not enable
  // allowImportingTsExtensions, so from this side it has to be written without.
  // Same file either way — that is the whole point of it being one file.
} from '../supabase/functions/redeem-code/codeFormat';

// ── Environment ─────────────────────────────────────────────────────────────
// Same .env.local hydration as scripts/sync-courses.ts, so Henry runs this the
// way he runs everything else here. Real environment variables win.
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1).trim();
    }
  }
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEPPER = process.env.REDEMPTION_CODE_PEPPER;

/**
 * Every one of these is fatal, and each says exactly what to do about it.
 *
 * Failing loudly matters more here than almost anywhere else in the codebase:
 * a silent fallback — a default pepper, a guessed project — would produce codes
 * that look perfectly fine on the printed card and then fail forever at
 * redemption, or worse, redeem against the wrong project. The cards will
 * already be printed by the time anyone finds out.
 */
function die(message: string): never {
  console.error(`\n  ERROR: ${message}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) {
  die('EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL) is not set. Put it in clippar_app/.env.local.');
}
if (!SERVICE_ROLE_KEY) {
  die(
    'SUPABASE_SERVICE_ROLE_KEY is not set. redemption_codes has no client grants at all ' +
      '(migration 018), so the anon key cannot write it — this needs the service role.',
  );
}
if (!PEPPER) {
  die(
    'REDEMPTION_CODE_PEPPER is not set.\n' +
      '  It must be byte-identical to the deployed function secret, or every code minted\n' +
      '  here hashes to something the redeem-code function will never match.\n\n' +
      '  Generate one:   openssl rand -base64 48\n' +
      '  Deploy it:      supabase secrets set REDEMPTION_CODE_PEPPER="<value>" --project-ref <ref>',
  );
}
/**
 * A short pepper is a pepper that can be brute-forced alongside the codes,
 * which collapses the whole argument for storing HMACs instead of digests
 * (see the header of migration 018). 32 characters is a floor, not a target;
 * `openssl rand -base64 48` gives 64.
 */
if (PEPPER.length < 32) {
  die(
    `REDEMPTION_CODE_PEPPER is only ${PEPPER.length} characters. It is the one secret standing ` +
      'between a leaked database and a list of live codes.\n\n  Generate a real one: openssl rand -base64 48',
  );
}

// ── Arguments ───────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const count = Number(argValue('--count') ?? 1);
const label = argValue('--label');
const expiresDaysRaw = argValue('--expires-days');

if (!Number.isInteger(count) || count < 1 || count > 500) {
  die('--count must be a whole number between 1 and 500.');
}
if (!label) {
  // Not optional in practice: an unlabelled code cannot be revoked with any
  // confidence later, because there is nothing to match it against — the hash
  // is one-way and the plaintext is gone.
  die('--label is required, e.g. --label "Ambassadors Aug 2026". It is the only way to ' +
    'identify a code after the fact; the plaintext is not recoverable.');
}

let expiresAt: string | null = null;
if (expiresDaysRaw !== undefined) {
  const days = Number(expiresDaysRaw);
  if (!Number.isFinite(days) || days <= 0) die('--expires-days must be a positive number of days.');
  expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
}

// ── Mint ────────────────────────────────────────────────────────────────────
/**
 * crypto.randomBytes, never Math.random.
 *
 * Math.random is a fast non-cryptographic PRNG (xorshift128+ in V8). Its
 * internal state is small, it is seeded from a low-entropy source, and its
 * outputs are famously recoverable: given a handful of consecutive values an
 * attacker can solve for the state and then generate every code the process
 * will ever produce, forwards and backwards. That turns 80 bits of apparent
 * entropy into zero and hands over the whole print run — which is exactly the
 * catastrophe the rate limits, the pepper and the atomic guard all exist to
 * prevent, arriving through the front door instead.
 *
 * randomBytes draws from the OS CSPRNG. Bytes are converted with a 5-bit slice
 * rather than a modulo (bytesToCode), so the 2^80 space is uniform.
 */
function mintCode(): string {
  const code = bytesToCode(randomBytes(CODE_ENTROPY_BYTES));
  // Cheap self-check: the generator and the verifier must agree on what a
  // well-formed code is, and this is the moment to find out that they do not.
  if (!isWellFormedCode(code) || normalizeCode(formatCodeForDisplay(code)) !== code) {
    die('internal: generated a code that does not survive normalisation. Refusing to insert.');
  }
  return code;
}

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const codes: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const code = mintCode();
    codes.push(code);
    rows.push({
      // ONLY the hash is ever sent. The plaintext stays in this process.
      code_hash: await hashCode(code, PEPPER!),
      label,
      grant_type: 'lifetime',
      max_uses: 1,
      expires_at: expiresAt,
    });
  }

  const { error } = await supabase.from('redemption_codes').insert(rows);
  if (error) {
    // Print nothing on failure. Codes that were never stored must not be handed
    // out, and a half-printed run is how a dead card ends up on a poster.
    die(`insert failed (${error.code ?? 'unknown'}): ${error.message}`);
  }

  const host = new URL(SUPABASE_URL!).host;
  console.log('');
  console.log(`  ${count} lifetime code${count === 1 ? '' : 's'} minted → ${host}`);
  console.log(`  label:   ${label}`);
  console.log(`  expires: ${expiresAt ? expiresAt : 'never (the code; the grant is always lifetime)'}`);
  console.log('');
  for (const code of codes) console.log(`    ${formatCodeForDisplay(code)}`);
  console.log('');
  console.log('  ── COPY THESE NOW ────────────────────────────────────────────────────');
  console.log('  Only the HMAC of each code was stored. There is no way to recover the');
  console.log('  plaintext — not from the database, not from a backup, not by re-running');
  console.log('  this script. When this terminal is closed, whatever you did not copy is');
  console.log('  gone for good. That is the point: it is also why a leak of the database');
  console.log('  is not a leak of the codes.');
  console.log('');
  console.log('  Treat the list like cash. Do not paste it into a chat, a note, or a file.');
  console.log('  Lost a card? Set revoked_at on its row and mint a replacement.');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('');
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
