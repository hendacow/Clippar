import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const ALLOWED_COPIES = new Set([
  // The HOME of these literals — where they are defined, not a copy of them.
  // It was exempt only because the old extension filter happened to drop `.py`,
  // which is an accident rather than a decision. Widening the scan surfaced it
  // immediately, which is the argument for scanning the tracked tree.
  'app.py',
  'clippar_app/.env.development.local.example',
]);

/**
 * Widened from `reports/` to the tree, because the rule was written as a
 * PROPERTY and enforced as a PLACE — the exact mistake catalogued as finding
 * 52, in the control meant to embody the lesson. A tracked copy of a guarded
 * value was sitting outside the scanned directory the whole time, and dotfiles
 * were skipped besides, so widening the directory alone would not have found
 * it either.
 */
function scannableFiles(): string[] {
  return trackedTextFiles().map((rel) => join(repoRoot, rel));
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
 * Identifiers that name an UNFIXED, LIVE finding, and the one file each may
 * appear in.
 *
 * A table rather than one hard-coded derivation, because the single-identifier
 * version guarded finding 32's cache and nothing else — so finding 12's
 * mechanism was published in six other places while this file stayed green.
 * Third recurrence of "stated a property, enforced a place", and the fix is not
 * a longer list of places: one entry per guarded thing, checked over every
 * tracked file.
 *
 * Each identifier is DERIVED from its home file, never written here. A guard
 * that restates what it protects has become the leak.
 */
const GUARDED: { home: string; derive: (src: string) => string[] }[] = [
  {
    // finding 32 — the module-scope session cache
    home: 'clippar_app/lib/storage.ts',
    derive: (src) =>
      [...src.matchAll(/^let ([A-Za-z_$][\w$]*): string \| null = null;$/gm)].map((m) => m[1]),
  },
  {
    // finding 12 — the unscoped media sweep
    home: 'clippar_app/lib/localWipe.ts',
    derive: (src) =>
      [...src.matchAll(/^async function (remove[A-Z]\w*MediaDirectories)\(/gm)].map((m) => m[1]),
  },
];

/**
 * Files that reference a guarded symbol AS CODE rather than explaining it. An
 * assertion naming the function it pins is not a disclosure; a sentence saying
 * why that function is dangerous is. Explicit and reasoned, so the next one is
 * a decision rather than a directory that happens not to be scanned.
 */
const GUARDED_CODE_REFS = new Set(['clippar_app/tests/serialQueue.test.ts']);

/**
 * The pointer blocks in the HOME files, pinned verbatim.
 *
 * `GUARDED` filters `rel !== home`, so a home file is exempt for its own
 * identifier by construction — the check only ever answers "is this named
 * elsewhere", never "is the mechanism explained here". That gap let a docstring
 * state the property and the unfixed status in the same block as the
 * implementation fifteen lines below, which is synthesis rather than citation.
 *
 * Fifth recurrence of "stated a property, enforced a place", one level up
 * inside the control. Same remedy as REDACTED_HEADINGS: pin the text, so
 * re-wording it is a deliberate act with a re-approval attached rather than a
 * drift. A phrase list would have been the sixth recurrence.
 */
const HOME_POINTERS: { file: string; mustContain: string; mustNotContain: string[] }[] = [
  {
    file: 'clippar_app/lib/storage.ts',
    mustContain: 'Why is deliberately not written here.',
    // Property statements, not warnings. A warning says "do not build on this";
    // these say what the failure IS, which is the tracker's job.
    //
    // The array written IS the array that runs. A `.slice(0, 2)` used to sit on
    // the closing line, dropping a third phrase — and that phrase was the only
    // one of the three that actually matched the file. So this assertion was
    // green because it had been trimmed to miss, which is a security test
    // weakened to pass: the thing this review spent the night criticising,
    // written by me, undocumented, in the control added to stop it.
    //
    // Deliberately NOT listed: "unfixed and live in shipped code". That is the
    // STATUS, not the mechanism, and the status is the half kept on purpose —
    // a pointer that will not say the finding is unfixed reads as ordinary
    // caution and gets ignored. Same call as the pinned heading of finding 12,
    // which states the effect and withholds the how.
    mustNotContain: [
      'account other than the one currently signed in',
      'null is not the only failure mode',
      // Cut in the sixth redaction pass: this characterises WHICH failure mode
      // is the wrong one to guard against, which narrows the search for anyone
      // reading the implementation a few lines below.
      'necessary but NOT sufficient',
      // Blast radius. "Four destructive gates are built on a function
      // documented as unsafe" is a map, not a warning.
      'four destructive gates were built on top of it',
    ],
  },
];

test('the home files point at the tracker instead of explaining the finding', () => {
  for (const { file, mustContain, mustNotContain } of HOME_POINTERS) {
    const body = readFileSync(join(repoRoot, file), 'utf8');
    assert.ok(
      body.includes(mustContain),
      `${file} lost its "why is withheld" pointer — the warning without it reads as an oversight rather than a decision`
    );
    for (const phrase of mustNotContain) {
      assert.ok(
        !body.includes(phrase),
        `${file} states the withheld property ("${phrase}") in the same file as the implementation. Point at the tracker instead.`
      );
    }
  }
});

for (const { home, derive } of GUARDED) {
  test(`${home}: guarded identifiers are named only where they are defined`, () => {
    const names = derive(readFileSync(join(repoRoot, home), 'utf8'));
    // Loudly, in both directions: none means the derivation broke or the finding
    // was fixed away; more than one means it may be guarding the wrong name.
    assert.equal(
      names.length,
      1,
      names.length === 0
        ? `could not derive the guarded identifier from ${home} — if the finding is fixed and it is gone, remove its GUARDED entry deliberately`
        : `the derivation is ambiguous: ${names.length} matches in ${home}`
    );
    const name = names[0];
    const offenders = trackedTextFiles()
      .filter((rel) => rel !== home)
      .filter((rel) => !GUARDED_CODE_REFS.has(rel))
      .filter((rel) => readFileSync(join(repoRoot, rel), 'utf8').includes(name));
    assert.deepEqual(
      offenders,
      [],
      `these files name a guarded identifier outside the file that defines it — point at the private tracker instead of restating the mechanism:\n${offenders.join('\n')}`
    );
  });
}

/**
 * Every tracked file, so both guards are properties of the REPOSITORY rather
 * than of whichever directories someone remembered to list.
 *
 * The previous version walked `reports/` and `clippar_app/`. The repo root also
 * holds README.md, several audit markdown files, docs/, scripts/, templates/
 * and .github/ — none of it scanned, and dotfiles were skipped besides. Going
 * from one directory to two is a longer list, not a property.
 *
 * Throws rather than returning [] if git is unavailable: a guard that passes
 * vacuously is worse than no guard at all.
 */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  const files = out
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !/(^|\/)(node_modules|ios|android|dist|build|\.expo)\//.test(rel))
    .filter(
      (rel) =>
        /\.(ts|tsx|js|jsx|md|json|ya?ml|sh|py|html|example)$/.test(rel) ||
        /(^|\/)\.env[^/]*$/.test(rel)
    );
  if (files.length === 0) {
    throw new Error('git ls-files returned nothing — this guard would pass vacuously');
  }
  return files;
}

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
