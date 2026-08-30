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

/** `os.getenv("NAME", "literal")` / `os.environ.get(...)`, closing paren required. */
const STRICT_FALLBACK =
  /os\.(?:getenv|environ\.get)\(\s*["'][A-Z_]*(?:KEY|PASSWORD|SECRET|TOKEN)["']\s*,\s*["']([^"']+)["']\s*\)/g;

/**
 * Deliberately looser than STRICT_FALLBACK: no `os.` prefix, no closing paren,
 * flexible spacing. Same semantics, weaker syntax — so if this finds a
 * credential-shaped default and the strict pattern does not, the strict
 * pattern has drifted rather than the credentials having been removed.
 */
const LOOSE_FALLBACK =
  /(?:getenv|environ\s*\.\s*get)\s*\(\s*["'][A-Z_]*(?:KEY|PASSWORD|SECRET|TOKEN)["']\s*,\s*["']([^"']+)["']/g;

function appPySource(): string | null {
  try {
    return readFileSync(join(repoRoot, 'app.py'), 'utf8');
  } catch {
    return null; // Service removed — nothing to keep out of the reports.
  }
}

function fallbackLiterals(source: string | null, pattern: RegExp): string[] {
  if (source == null) return [];
  const found = new Set<string>();
  for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
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

/** Literal defaults in `os.getenv("NAME", "literal")` / `os.environ.get(...)`. */
function fallbackLiteralsInAppPy(): string[] {
  return fallbackLiterals(appPySource(), STRICT_FALLBACK);
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
  // With no literals the check below passes vacuously on any report, and there
  // are two ways to get there. The extraction pattern drifted — bad, and the
  // reason this test exists. Or finding 5 was remediated and the fallbacks are
  // gone — good, and it must NOT go red for it: the earlier version asserted
  // `literals.length > 0` outright, so whoever switched app.py to required env
  // vars broke `npm run verify` and had to delete a test file in the same
  // commit to get green. A security test that punishes the security fix is a
  // security fix that gets deferred.
  //
  // The loose pattern tells the two apart. It is strictly weaker syntax with
  // identical filters, so it still matches a reformatted call that the strict
  // one misses — but it matches nothing once the defaults are actually gone.
  const source = appPySource();
  if (source == null) return; // service removed
  if (fallbackLiterals(source, LOOSE_FALLBACK).length === 0) return; // remediated

  assert.ok(
    fallbackLiteralsInAppPy().length > 0,
    'app.py still has credential-shaped getenv defaults but none were extracted — the extraction pattern has drifted'
  );
});

/**
 * Copies of a guarded value that exist ON PURPOSE, each with its reason.
 *
 * This list is the point, not a loophole. `EXPO_PUBLIC_PIPELINE_API_KEY` in
 * the env example is the CLIENT half of the same shared secret `app.py` falls
 * back to — it is already embedded in every shipped bundle by design (see
 * `clippar_app/CLAUDE.md`, "Secret keys ship in the client"), so the example
 * file is not where that exposure lives and deleting it here would hide a
 * known problem rather than fix it. It is also a developer-setup decision
 * rather than a security one, so it is recorded for Henry instead of changed
 * unilaterally.
 *
 * **The consequence that matters is in the report:** rotating the server-side
 * value requires shipping a new app build, because the client carries the
 * matching one.
 *
 * A named copy with a reason beats a directory that happens not to be scanned.
 */
const ALLOWED_COPIES = new Set(['clippar_app/.env.development.local.example']);

/**
 * Widened from `reports/` to the tree, because the rule was written as a
 * PROPERTY and enforced as a PLACE — the exact mistake catalogued as finding
 * 52, in the control meant to embody the lesson. A tracked copy of a guarded
 * value was sitting outside the scanned directory the whole time, and dotfiles
 * were skipped besides, so widening the directory alone would not have found
 * it either.
 */
function scannableFiles(): string[] {
  const out = [
    ...markdownFilesUnder(join(repoRoot, 'reports')),
    ...textFilesUnder(join(repoRoot, 'clippar_app')),
  ];
  // The env examples: dotfiles, so every generic walker skips them, which is
  // why this copy stayed invisible.
  for (const name of ['.env.development.local.example', '.env.staging.local.example']) {
    const full = join(repoRoot, 'clippar_app', name);
    try {
      statSync(full);
      out.push(full);
    } catch {
      // absent is fine
    }
  }
  return out;
}

test('no tracked file quotes a fallback credential instead of citing its line', () => {
  const literals = fallbackLiteralsInAppPy();
  const files = scannableFiles();
  assert.ok(files.length > 0, 'expected to find files to scan');

  // Name the offending FILE, never the matched line — the same rule this test
  // enforces applies to its own failure output.
  const offenders = files
    .filter((file) => {
      const body = readFileSync(file, 'utf8');
      return literals.some((secret) => body.includes(secret));
    })
    .map((file) => file.slice(repoRoot.length + 1))
    .filter((rel) => !ALLOWED_COPIES.has(rel));

  assert.deepEqual(
    offenders,
    [],
    `these files quote a credential; cite the location (e.g. app.py:31) instead:\n${offenders.join('\n')}`
  );
});

/**
 * The same rule, applied to an unfixed vulnerability rather than a credential.
 *
 * Finding 33: this repository is public and finding 32 is unfixed and live in
 * shipped code. What raises the exposure is not the code — that is readable
 * either way — it is the SYNTHESIS: naming the mechanism, the condition that
 * triggers it, every gate that depends on it, and confirming it is deliberately
 * unfixed. That belongs in the private tracker, and `lib/storage.ts` carries a
 * pointer to it rather than the detail.
 *
 * This test exists because the rule was applied by hand five times and missed a
 * sibling every time — the report body, the source comment in `lib/clipBin.ts`,
 * two comment blocks in `tests/serialQueue.test.ts`, and the PR description.
 * Finding 52 was that a rule written as a list of places is a snapshot of what
 * you were thinking when you wrote it. **The fix for that is not a longer list;
 * it is a check that runs.**
 *
 * The identifier is DERIVED from `lib/storage.ts` rather than written here, for
 * the same reason the credential literals are derived from app.py: a test that
 * restates the thing it is protecting has become the leak.
 */

/**
 * The module-scope session cache in lib/storage.ts, by name, read from source.
 *
 * Returns every declaration of that shape, not the first. The first version of
 * this used `String.match` without `/g`, which returns match one and ignores
 * the rest — so a second `let x: string | null = null;` added ABOVE the cache
 * would silently redirect the guard to the wrong identifier while this test
 * went on passing. The write-up claimed it "fails loudly rather than vacuously
 * if the declaration moves"; that covered the declaration DISAPPEARING and not
 * the derivation becoming AMBIGUOUS, which is the failure that leaks.
 *
 * Same shape as everything else this review kept finding: a guard that reads
 * stronger than it is. Worth spelling out because it was in the control added
 * to stop exactly that.
 */
function sessionCacheIdentifiers(): string[] {
  const storage = readFileSync(join(repoRoot, 'clippar_app/lib/storage.ts'), 'utf8');
  return [...storage.matchAll(/^let ([A-Za-z_$][\w$]*): string \| null = null;$/gm)].map(
    (m) => m[1]
  );
}

test('the session cache is named only where it is defined, not explained elsewhere', () => {
  const names = sessionCacheIdentifiers();
  // Fail loudly rather than passing vacuously, in BOTH directions: zero
  // declarations means the derivation broke or the finding was fixed away, and
  // more than one means the derivation is ambiguous and may be guarding the
  // wrong name. A redaction test that silently stops testing is worse than none.
  assert.equal(
    names.length,
    1,
    names.length === 0
      ? 'could not derive the session cache identifier from lib/storage.ts — if finding 32 is fixed and it is gone, delete this test deliberately'
      : `the derivation is ambiguous: ${names.length} declarations match, so this test may be guarding the wrong identifier. Narrow the pattern or name the cache explicitly here.`
  );
  const name = names[0];

  // storage.ts is where it lives; the private tracker is where it is explained.
  const HOME = 'clippar_app/lib/storage.ts';
  const roots = [join(repoRoot, 'clippar_app'), join(repoRoot, 'reports')];
  const files = roots.flatMap((r) => textFilesUnder(r));
  assert.ok(files.length > 0, 'expected to find files to scan');

  const offenders = files
    .map((file) => file.slice(repoRoot.length + 1))
    .filter((rel) => rel !== HOME)
    .filter((rel) => readFileSync(join(repoRoot, rel), 'utf8').includes(name));

  assert.deepEqual(
    offenders,
    [],
    `these files name the session cache outside the file that defines it — point at the private tracker instead of restating the mechanism:\n${offenders.join('\n')}`
  );
});

/** Source and markdown files, skipping build output and dependencies. */
function textFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'ios', 'android', 'dist', '.expo', 'build']);
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || skip.has(entry)) continue;
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|md)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The headings of the unfixed-and-live findings, pinned verbatim.
 *
 * The guard above checks an IDENTIFIER. A heading can state the same mechanism
 * in plain English and the identifier never appears — which is exactly what
 * happened: finding 32's heading read as a one-line statement of the defect,
 * directly above a body saying "Detail withheld", and this file was green the
 * whole time. That is the "stated a property, enforced a place" error (finding
 * 68) reappearing inside the control added to stop it, for the third time.
 *
 * A word blacklist would be the fourth. Instead these headings are pinned
 * exactly: change one and this goes red, so re-wording a redacted finding
 * becomes a deliberate act with a re-approval attached rather than a drift.
 *
 * Naming the finding numbers here discloses nothing new — the report already
 * says which findings are escalated and live; that is the severity half, kept
 * on purpose so Henry can rank them. What is withheld is the mechanism.
 */
const REDACTED_HEADINGS: Record<string, string> = {
  '12': "HIGH — account deletion destroys the other account's videos (out of diff, NOT fixed)",
  '32': 'HIGH — the session-identity primitive every ownership gate reads (escalated, authentication code)',
};

test('the redacted findings’ headings stay neutral', () => {
  const report = readFileSync(join(repoRoot, 'reports/cto/2026-08-30.md'), 'utf8');
  for (const [num, expected] of Object.entries(REDACTED_HEADINGS)) {
    const m = report.match(new RegExp(`^### ${num}\\. (.+)$`, 'm'));
    assert.notEqual(
      m,
      null,
      `finding ${num}'s heading is gone — if it was renumbered or removed, update REDACTED_HEADINGS deliberately`
    );
    assert.equal(
      m![1],
      expected,
      `finding ${num}'s heading changed. It describes an unfixed, live-in-shipped-code defect in a public repo, so the heading is part of the redaction. If the new wording is deliberate and still withholds the mechanism, update REDACTED_HEADINGS in the same commit.`
    );
  }
});
