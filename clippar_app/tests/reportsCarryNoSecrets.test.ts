import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const GUARDED: { home: string; tag: string }[] = [
  { home: 'clippar_app/lib/storage.ts', tag: '32' },   // see the private tracker
  { home: 'clippar_app/lib/localWipe.ts', tag: '12' }, // see the private tracker
];

/**
 * Derive the guarded identifier from an explicit `@guarded <n>` marker in its
 * home file, rather than from a regex describing the declaration's shape.
 *
 * Two reasons, and the second is the one that caught me. The shape regexes
 * this replaces reconstructed what they were hiding — one spelled the guarded
 * name to within a word, in the guard whose entire job is keeping that name
 * out of every file but its home. The table's comments described the
 * mechanism in English besides. `GUARDED` only asks whether the identifier
 * appears elsewhere, so it stayed green while its own annotations published
 * what it protects. A finding NUMBER discloses nothing; a description does.
 *
 * And a marker is simply better: finding 65 was this derivation silently
 * guarding the wrong name because a second declaration matched the same shape.
 * An explicit tag cannot drift onto something else.
 */
function deriveGuarded(src: string, tag: string): string[] {
  const pattern = new RegExp(
    `@guarded ${tag} \\*/\\s*(?:export\\s+)?(?:let|const|async function|function)\\s+([A-Za-z_$][\\w$]*)`,
    'g'
  );
  return [...src.matchAll(pattern)].map((m) => m[1]);
}
/**
 * Files that reference a guarded symbol AS CODE rather than explaining it. An
 * assertion naming the function it pins is not a disclosure; a sentence saying
 * why that function is dangerous is. Explicit and reasoned, so the next one is
 * a decision rather than a directory that happens not to be scanned.
 */
const GUARDED_CODE_REFS = new Set(['clippar_app/tests/serialQueue.test.ts']);

/**
 * The pointer blocks in the HOME files, pinned BY DIGEST.
 *
 * `GUARDED` filters `rel !== home`, so a home file is exempt for its own
 * identifier by construction — the check only ever answers "is this named
 * elsewhere", never "is the mechanism explained here". That gap let a docstring
 * state the property and the unfixed status in the same block as the
 * implementation fifteen lines below, which is synthesis rather than citation.
 *
 * This used to be a list of the sentences CUT from that docstring for being too
 * revealing — written out verbatim, in a tracked file, in a public repo, each
 * one annotated with why it was too revealing. The guard only ever asked
 * whether an identifier appeared elsewhere, so it stayed green while it was
 * itself the second copy of the thing it existed to withhold. The file's own
 * comment warned that "a phrase list would have been the sixth recurrence" and
 * a phrase list is what it shipped.
 *
 * A digest carries none of that and is strictly stronger in the direction that
 * matters: a phrase list catches only the four sentences someone thought of,
 * while the digest goes red on ANY regrowth of the block. What it gives up is
 * reach — it pins this block rather than searching the whole file, so a cut
 * sentence reappearing elsewhere in `storage.ts` is not caught. That is the
 * honest limit, stated rather than papered over.
 *
 * To regenerate after a deliberate re-wording: run this test, and paste the
 * digest it reports as "actual". `pointerBlock` below defines the extent
 * exactly, so there is no second implementation to drift from it.
 */
const HOME_POINTERS: { file: string; sentinel: string; sha256: string }[] = [
  {
    file: 'clippar_app/lib/storage.ts',
    // The kept half, and it discloses nothing on its own: it says the reasoning
    // is elsewhere. A pointer that will not admit the finding is real and open
    // reads as generic caution and gets skipped — which is how the sentence it
    // replaced did its damage.
    sentinel: 'Why is deliberately not written here.',
    sha256: '79b005f1839edef170c7501a57503fe5f1af774350bffaabf7eed761079e367e',
  },
  {
    // The docstring ON the guarded declaration itself, ~480 lines above the
    // entry that pins `currentSessionUserId`. It was uncovered, and what sat
    // there was a REASSURANCE: it asserted the safety property finding 32 says
    // this value does not have, directly under the marker that identifies it.
    // Same defect as the docstring already fixed below, in its sibling, found
    // by a reviewer rather than by me carrying the fix across.
    file: 'clippar_app/lib/storage.ts',
    sentinel: 'The reasoning is deliberately kept out of this file.',
    sha256: '9e30dec5b45ac2f2d8bbe1ca1d58d42d94525e0bd512b17b7fdc7a459a2c77fa',
  },
  {
    // `localWipe.ts` had no coverage at all. `GUARDED` exempts a home file for
    // its own identifier by construction, so nothing constrained what could be
    // written beside `@guarded 12` — now or later.
    file: 'clippar_app/lib/localWipe.ts',
    sentinel: 'is deliberately not spelled out here',
    sha256: '517f8e8ca5e957d897735ce6a5074e1273897975edfc26b99f07b0df49f9a0af',
  },
];

/**
 * The contiguous run of comment lines containing `sentinel`, or null if it is
 * gone.
 *
 * Line-based rather than `/** … *​/`-delimited, because one of the pointers is
 * a `//` run inside a function body rather than a docstring. A delimiter search
 * there walks backwards past the closing of an unrelated block and pins a
 * region spanning most of the file — green, enormous, and meaningless.
 */
function pointerBlock(src: string, sentinel: string): string | null {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes(sentinel));
  if (at === -1) return null;
  const isComment = (l: string) => /^\s*(\/\/|\/?\*)/.test(l);
  let first = at;
  let last = at;
  while (first > 0 && isComment(lines[first - 1])) first--;
  while (last < lines.length - 1 && isComment(lines[last + 1])) last++;
  return lines.slice(first, last + 1).join('\n');
}

test('the home files point at the tracker instead of explaining the finding', () => {
  for (const { file, sentinel, sha256 } of HOME_POINTERS) {
    const block = pointerBlock(readFileSync(join(repoRoot, file), 'utf8'), sentinel);
    assert.notEqual(
      block,
      null,
      `${file} lost its "why is withheld" pointer — the warning without it reads as an oversight rather than a decision`
    );
    assert.equal(
      createHash('sha256').update(block!, 'utf8').digest('hex'),
      sha256,
      `${file}'s pointer block changed. It is the block that withholds an unfixed, live-in-shipped-code mechanism in a public repo, so its wording is part of the redaction. If the new wording still points at the tracker rather than explaining the finding, regenerate the digest in the same commit.`
    );
  }
});

for (const { home, tag } of GUARDED) {
  test(`${home}: guarded identifiers are named only where they are defined`, () => {
    const names = deriveGuarded(readFileSync(join(repoRoot, home), 'utf8'), tag);
    // Loudly, in both directions: none means the derivation broke or the finding
    // was fixed away; more than one means it may be guarding the wrong name.
    assert.equal(
      names.length,
      1,
      names.length === 0
        ? `no @guarded ${tag} marker resolved in ${home} — if the finding is fixed and the marker is gone, remove its GUARDED entry deliberately`
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
 * A word blacklist would be the fourth. Instead these headings are pinned BY
 * DIGEST: change one and this goes red, so re-wording a redacted finding
 * becomes a deliberate act with a re-approval attached rather than a drift.
 *
 * Pinned by digest rather than verbatim, because the verbatim version restated
 * both headings in a tracked public file — and one of them still carried the
 * blast radius, the same category of sentence that had already been cut from
 * `storage.ts` for being a map rather than a warning. A guard that has to quote
 * the text to protect it has become the second copy.
 *
 * Naming the finding numbers here discloses nothing new — the report already
 * says which findings are escalated and live; that is the severity half, kept
 * on purpose so Henry can rank them. What is withheld is the mechanism.
 *
 * Regenerate with:
 *   node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' '<heading text after the number>'
 */
const REDACTED_HEADING_SHA256: Record<string, string> = {
  '12': 'b1a3a909509b5fcb3d6bbdd85efc82f20ddd1eefcd70484d2e5cebd63f988540',
  '32': 'd51651e0e1bb3aba8e38a314fc61585712e6749278d9ce986bbe6660f2e32eeb',
};

/**
 * The SUMMARY-TABLE rows for the same findings, pinned the same way.
 *
 * The headings test looks at `### <n>.` and nothing else. The severity table
 * two hundred lines above it carried the full mechanism for both findings — for
 * 32, the defect, the trigger and "LIVE IN PRODUCTION" in one bold row — while
 * this file reported green over it. Sixth recurrence of "stated a property,
 * enforced a place", inside the control.
 *
 * The miss is worth recording precisely: the previous pass neutralised finding
 * 12's row and not finding 32's, because I searched for the wording I remembered
 * writing rather than for the property. A pin does not care what I remember.
 */
const REDACTED_TABLE_SHA256: Record<string, string> = {
  '12': '4fcb857e543518c59f08bcb4df1fe3fd5b20fbea0eda1822b914e0c81a8f3c7b',
  '23': 'f10d27fa9e236498d4e8c40f0c440b1456ce65edf46e417d78868cee3df091e6',
  '29': 'e14812596b6e5e370dc73adb4778cca7a9c20cd9a54826915e4ac377aeee0a03',
  '32': '5d9a5a00b21686d704d6dd527b3aeb11c44a4ea2363885506ac648c048414c65',
};

/** The whole row, so the STATUS cell is covered too, not just the description. */
function tableRow(report: string, finding: string): string | null {
  const m = report.match(new RegExp(`^\\| ${finding} \\|.*$`, 'm'));
  return m ? m[0] : null;
}

test('the redacted findings’ summary-table rows stay neutral', () => {
  const report = readFileSync(join(repoRoot, 'reports/cto/2026-08-30.md'), 'utf8');
  for (const [num, digest] of Object.entries(REDACTED_TABLE_SHA256)) {
    const row = tableRow(report, num);
    assert.notEqual(
      row,
      null,
      `finding ${num}'s summary-table row is gone — if it was renumbered or removed, update REDACTED_TABLE_SHA256 deliberately`
    );
    assert.equal(
      createHash('sha256').update(row!, 'utf8').digest('hex'),
      digest,
      `finding ${num}'s summary-table row changed. It summarises an unfixed, live-in-shipped-code defect in a public repo, so the row is part of the redaction — and it is the line that carried the mechanism while the section body said "Detail withheld". If the new wording still withholds it, regenerate the digest in the same commit.`
    );
  }
});

/**
 * The `## Needs Henry` items for the redacted findings, pinned the same way.
 *
 * The fourth surface, and the one that mattered most: it is the section the
 * founder actually reads, and its item for finding 32 carried the precondition,
 * the trigger, the outcome and the blast radius in four sentences of plain
 * English — a fuller account than either the heading or the table row that had
 * already been neutralised, sitting directly under a neighbouring item that
 * correctly said "Detail withheld".
 *
 * **All four existing guards missed it by construction**, which is the general
 * lesson rather than an oversight: a numbered list item is not an `### <n>.`
 * heading and not a `| <n> |` table row, and `GUARDED` compares an IDENTIFIER —
 * it cannot see a paraphrase, and a paraphrase is what a reader actually needs.
 * Tenth recurrence of "stated a property, enforced a place".
 *
 * The item is located by the finding named on its OWN first line, never by
 * position — the numbering shifts — and never by a body mention, because item 7
 * cross-references finding 12 and an ambiguous derivation silently guarding the
 * wrong text is finding 65. `needsHenryItem` returns null on 0 or 2+ matches so
 * ambiguity fails loudly instead of pinning the wrong item.
 */
const REDACTED_NEEDS_HENRY_SHA256: Record<string, string> = {
  '12': '3403696a8e19075715f9fc939cdc2435ba8fc5bce6798b34d612ae197a215f09',
  '23': '881eba071c394dd1ab79d3c9199d93c7835dba3025e730a12de8503bdb4d8c92',
  // 23 and 29 share one item ("Finding 23/29 — …"), so they share its digest.
  // Both are listed rather than one: the derived coverage check asks per
  // finding, and a shared surface is still a surface each of them has.
  '29': '881eba071c394dd1ab79d3c9199d93c7835dba3025e730a12de8503bdb4d8c92',
  '32': 'e249dad81c945592498d78a8fdb18efd233179aa7e40d1aa81271b58316753f3',
};

/** The one `## Needs Henry` item whose FIRST LINE names `finding`, or null. */
function needsHenryItem(report: string, finding: string): string | null {
  const at = report.indexOf('\n## Needs Henry');
  if (at === -1) return null;
  const items = report.slice(at).split(/\n(?=\d+\. )/).slice(1);
  const re = new RegExp(`\\bfindings? [\\d/]*\\b${finding}\\b`, 'i');
  const hits = items.filter((i) => re.test(i.split('\n')[0]));
  return hits.length === 1 ? hits[0].trimEnd() : null;
}

test('the Needs Henry items for redacted findings stay neutral', () => {
  const report = readFileSync(join(repoRoot, 'reports/cto/2026-08-30.md'), 'utf8');
  for (const [num, digest] of Object.entries(REDACTED_NEEDS_HENRY_SHA256)) {
    const item = needsHenryItem(report, num);
    assert.notEqual(
      item,
      null,
      `finding ${num}'s Needs Henry item did not resolve to exactly one entry — it was removed, renumbered, or a second item now names it on its first line. Fix the ambiguity rather than the digest.`
    );
    assert.equal(
      createHash('sha256').update(item!, 'utf8').digest('hex'),
      digest,
      `finding ${num}'s Needs Henry item changed. It is prose about an unfixed, live-in-shipped-code defect in a public repo, so its wording is part of the redaction. If the new wording still withholds the mechanism, regenerate the digest in the same commit.`
    );
  }
});

/**
 * The three maps above are keyed on a hand-written list of finding numbers.
 *
 * **That is "stated a property, enforced a place" one level up, and it is the
 * reason this control has needed eleven passes.** Each pass added a surface —
 * headings, then table rows, then Needs Henry items — and every one of them
 * still only protects the findings someone remembered to list. Findings 23 and
 * 29 were re-rated to unfixed-and-live hours ago and were never added, so their
 * rows stated the mechanism and the reachability while all three maps reported
 * green. Nothing structural stopped that; it needed a person to notice.
 *
 * So the key set is DERIVED from the report. A finding is redacted because of a
 * property it has — unfixed AND live in shipped code — marked in its status
 * cell as `🔴 LIVE`. Re-rate a finding to live, and this test fails until its
 * surfaces are pinned, at the moment of the re-rating rather than at the next
 * manual sweep.
 *
 * **Deliberately NOT the obvious predicate.** "High severity AND escalated"
 * was suggested and is wrong in both directions: it sweeps in finding 40
 * ("goes live on merge" — not live yet) and finding 34 (branch-only), costing
 * information for no gain, and it MISSES finding 23, which is rated Medium and
 * is live. Severity is not the property. Reachability in shipped code is, and
 * it has to be written down to be checkable — which is why the marker exists.
 */
function liveUnfixedFindings(report: string): string[] {
  return [...report.matchAll(/^\| (\d+) \| (.*?) \| (.*?) \| (.*?) \|$/gm)]
    .filter((m) => m[4].includes('🔴 LIVE'))
    .map((m) => m[1]);
}

test('every finding marked LIVE has all of its public surfaces pinned', () => {
  const report = readFileSync(join(repoRoot, 'reports/cto/2026-08-30.md'), 'utf8');
  const live = liveUnfixedFindings(report);
  // A renamed marker or a reshaped table would otherwise make this pass while
  // checking nothing — the same vacuous-green failure as an empty file list.
  assert.ok(
    live.length > 0,
    'no summary-table row is marked 🔴 LIVE — the marker was renamed or the table reshaped, and this guard would pass vacuously'
  );

  const unpinnedRow = live.filter((n) => !(n in REDACTED_TABLE_SHA256));
  assert.deepEqual(
    unpinnedRow,
    [],
    `these findings are marked live in shipped code but their summary-table rows are not pinned: ${unpinnedRow.join(', ')}. Neutralise the row, then add its digest.`
  );

  const unpinnedHeading = live.filter(
    (n) => new RegExp(`^### ${n}\\.`, 'm').test(report) && !(n in REDACTED_HEADING_SHA256)
  );
  assert.deepEqual(
    unpinnedHeading,
    [],
    `these findings are marked live and have a section heading, but it is not pinned: ${unpinnedHeading.join(', ')}`
  );

  const unpinnedNeeds = live.filter(
    (n) => needsHenryItem(report, n) != null && !(n in REDACTED_NEEDS_HENRY_SHA256)
  );
  assert.deepEqual(
    unpinnedNeeds,
    [],
    `these findings are marked live and have a Needs Henry item, but it is not pinned: ${unpinnedNeeds.join(', ')}`
  );
});

test('the redacted findings’ headings stay neutral', () => {
  const report = readFileSync(join(repoRoot, 'reports/cto/2026-08-30.md'), 'utf8');
  for (const [num, digest] of Object.entries(REDACTED_HEADING_SHA256)) {
    const m = report.match(new RegExp(`^### ${num}\\. (.+)$`, 'm'));
    assert.notEqual(
      m,
      null,
      `finding ${num}'s heading is gone — if it was renumbered or removed, update REDACTED_HEADING_SHA256 deliberately`
    );
    assert.equal(
      createHash('sha256').update(m![1], 'utf8').digest('hex'),
      digest,
      `finding ${num}'s heading changed. It heads an unfixed, live-in-shipped-code defect in a public repo, so the heading is part of the redaction. If the new wording is deliberate and still withholds the mechanism, regenerate its digest in the same commit.`
    );
  }
});
