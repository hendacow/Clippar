import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Clippar has not shipped, so it has no App Store rating, no rating count, and
// no user base to quote. constants/onboardingFlow.ts nonetheless carried eight
// invented golfer reviews and invented volume stats (4.8 stars, "2,140+"
// ratings attributed to the App Store, "9,200+" golfers, "38,000+" rounds),
// left over from the superseded 8-screen funnel design. Nothing imported them,
// but ONBOARDING_SALES_FLOW_SPEC.md still describes the proof-wall screen they
// were written for, and the comment above them said "swap for real ones before
// launch" — so the next person building that screen would have wired them in.
//
// Two reasons that must not happen:
//   1. An invented App Store rating shown in-app is an App Review problem in
//      its own right — it misrepresents a platform surface.
//   2. The audience is Australian: fabricated testimonials and unsubstantiated
//      volume claims are misleading conduct under ACL s18 / s29(1)(e).
//
// These tests are deliberately about INVENTED proof, not about social proof as
// a concept. Real, substantiable figures and consented quotes are fine — they
// just must not be hardcoded placeholder values. If you are adding real ones,
// source them at runtime (or from a reviewed constant with evidence recorded)
// rather than by re-pasting the numbers below.
//
// Sibling of tracerClaims.test.ts, which guards the same class of problem for
// the shot tracer. Same source-assertion idiom as tempExportWiring.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');

/** Strip comments — prose explaining why these values are banned must not
 *  itself trip the ban. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Every shipped .ts/.tsx source file (app code + constants + components +
 *  hooks + lib), excluding tests and generated/vendored trees. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'tests', 'ios', 'android', '.expo', 'dist']);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(repo);
  return out;
}

test('the invented testimonials and proof stats are gone', () => {
  const src = read('constants/onboardingFlow.ts');
  const code = codeOnly(src);
  for (const gone of ['testimonials', 'proofStats', 'Testimonial']) {
    assert.doesNotMatch(
      code,
      new RegExp(`export (const|interface|type) ${gone}\\b`),
      `constants/onboardingFlow.ts must not re-export ${gone} — it held fabricated social proof`
    );
  }
});

test('the specific invented figures appear nowhere in shipped source', () => {
  // The exact placeholder values, so a copy-paste revival is caught wherever it
  // lands — not just in the file they used to live in.
  const banned: [RegExp, string][] = [
    [/2,140\+/, 'invented App Store rating count'],
    [/9,200\+/, 'invented golfer count'],
    [/38,000\+/, 'invented rounds-captured count'],
    [/@dave_plays_off_18|@steph\.swings|@weekend_hacker_jase|@priya\.golfs/, 'invented reviewer handle'],
    [/@macca_2under_dreaming|@tara\.tee\.time|@robbo_golf_gc|@liamh\.golf/, 'invented reviewer handle'],
  ];
  for (const file of sourceFiles()) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const [pattern, what] of banned) {
      assert.doesNotMatch(
        code,
        pattern,
        `${relative(repo, file)} contains a ${what} (${pattern.source}). ` +
          'Clippar has not shipped — it has no ratings and no user base to cite.'
      );
    }
  }
});

test('no source file hardcodes an App Store star rating', () => {
  // Narrow on purpose: a bare 4.8 is a legitimate number in geometry, timing
  // and layout code. What is banned is a rating-shaped constant — a `rating`,
  // `stars` or `ratingCount` key holding a hardcoded value — which is how an
  // unshipped app ends up displaying a review score it cannot have.
  for (const file of sourceFiles()) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    const hit = /\b(rating|ratingCount|starRating|appStoreRating)\s*:\s*['"`]?[0-9]/.exec(code);
    assert.equal(
      hit,
      null,
      `${relative(repo, file)} hardcodes a rating value (${hit?.[0]}). ` +
        'Ratings must come from a real, substantiable source — never a literal.'
    );
  }
});
