import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Audit reports must cite a credential's LOCATION, never its value.
 *
 * A finding about a hardcoded fallback password is not improved by quoting the
 * password: the value is already in the repo, so the copy adds a second place
 * to find it — in a public repository, in a document written to be read and
 * circulated. `scripts/secret-scan.sh` makes the same argument about its own
 * output: it reports counts, never matched lines, because CI logs outlive
 * deleting the key from the tree.
 *
 * This caught a real instance — the 2026-08-30 CTO report reproduced the
 * `ADMIN_PASSWORD` fallback from app.py verbatim while noting the repo is
 * public. The finding reads exactly the same with a line reference instead.
 *
 * The values are DERIVED from app.py rather than listed here, so this file
 * does not become the extra copy it exists to prevent, and it keeps working if
 * someone adds a fourth fallback.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * Defaults that match the credential-shaped pattern but are not secrets, so a
 * report may name them freely. Kept as an explicit list rather than inferred:
 * a value only belongs here because someone decided it is public, never
 * because it happened to be short.
 */
const NON_SECRET_DEFAULTS = new Set(['true', 'false', 'none', 'null', 'development', 'production']);

/** Literal defaults in `os.getenv("NAME", "literal")` / `os.environ.get(...)`. */
function fallbackLiteralsInAppPy(): string[] {
  let source: string;
  try {
    source = readFileSync(join(repoRoot, 'app.py'), 'utf8');
  } catch {
    return []; // Service removed — nothing to keep out of the reports.
  }
  const pattern = /os\.(?:getenv|environ\.get)\(\s*["'][A-Z_]*(?:KEY|PASSWORD|SECRET|TOKEN)["']\s*,\s*["']([^"']+)["']\s*\)/g;
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const literal = match[1];
    if (!literal) continue;
    // A length floor stops ordinary words ("true", "dev") matching half the
    // prose in every report. It was 8, which would have let a SHORT fallback
    // credential be quoted verbatim while this test still passed — so it is 4
    // now, with the handful of non-secret defaults that live in this shape
    // allow-listed by value rather than waved through by length.
    if (literal.length < 4) continue;
    if (NON_SECRET_DEFAULTS.has(literal.toLowerCase())) continue;
    found.add(literal);
  }
  return [...found];
}

function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test('app.py fallback credentials are discoverable, so this test has teeth', () => {
  // If this ever returns nothing, the check above silently passes on any
  // report. Either the fallbacks were fixed (good — then delete this file) or
  // the pattern drifted (bad). Either way, notice rather than pass quietly.
  const literals = fallbackLiteralsInAppPy();
  assert.ok(
    literals.length > 0,
    'no fallback credentials found in app.py — if they were removed, drop this test'
  );
});

test('no report quotes a fallback credential instead of citing its line', () => {
  const literals = fallbackLiteralsInAppPy();
  const files = markdownFilesUnder(join(repoRoot, 'reports'));
  assert.ok(files.length > 0, 'expected to find report files to scan');

  // Name the offending FILE, never the matched line — the same rule this test
  // enforces applies to its own failure output.
  const offenders = files
    .filter((file) => {
      const body = readFileSync(file, 'utf8');
      return literals.some((secret) => body.includes(secret));
    })
    .map((file) => file.slice(repoRoot.length + 1));

  assert.deepEqual(
    offenders,
    [],
    `these reports quote a credential; cite the location (e.g. app.py:31) instead:\n${offenders.join('\n')}`
  );
});
