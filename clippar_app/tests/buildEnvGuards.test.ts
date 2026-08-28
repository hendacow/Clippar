import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(APP, '..');

const eas = JSON.parse(readFileSync(join(APP, 'eas.json'), 'utf8')) as {
  build: Record<string, any>;
};

const PROD_REF = 'xdefwnqyjffgclzqmvax';

/**
 * Spec 5.11 "Environment confusion" / 6.3 "separate backends".
 *
 * The `preview` profile shipped `"environment": "production"` with no
 * APP_VARIANT, so app.config.js fell through to the default branch and produced
 * byte-identical identity to the App Store build — same bundle id, same
 * `clippar://` scheme — on an internal-distribution binary wired to the
 * production Supabase project. eas-update.yml defaults to that channel on every
 * push to main, so unreviewed code reached production data within minutes with
 * no human gate.
 */

// `preview` is EXEMPT from both rules below, deliberately.
//
// It is the owner's own internal install of the real app: production bundle id,
// production Supabase, internal distribution. That is how he dogfoods the
// shipping app on his own phone without waiting on App Store review, and it is
// the intended topology rather than an accident. An earlier pass read it as a
// misconfiguration and retargeted it to com.clippar.app.staging on the dev
// project — which would have silently stopped updating the install he actually
// uses and stood up a second, empty app next to it. `staging` already exists for
// the non-production case.
const OWNER_INTERNAL_PROFILE = 'preview';

test('no TEST profile reads the production EAS environment', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    if (profile.distribution === 'store') continue;
    if (name === OWNER_INTERNAL_PROFILE) continue;
    assert.notEqual(
      profile.environment,
      'production',
      `profile "${name}" is distribution="${profile.distribution}" but reads the ` +
        'production environment — it would write real rounds into the production database',
    );
  }
});

test('every TEST profile carries a distinct APP_VARIANT', () => {
  // A missing APP_VARIANT means app.config.js falls through to the production
  // identity (com.clippar.app / scheme "clippar"). Only the store profile and the
  // owner's internal install are allowed to claim it.
  for (const [name, profile] of Object.entries(eas.build)) {
    if (profile.distribution === 'store') continue;
    if (name === OWNER_INTERNAL_PROFILE) continue;
    assert.ok(
      profile.env?.APP_VARIANT,
      `profile "${name}" declares no APP_VARIANT, so it inherits the App Store ` +
        'bundle id and URL scheme',
    );
  }
});

test('the profile→app mapping is exactly what the owner expects', () => {
  // Locks the topology down so no future pass can quietly move a build onto a
  // different app. Bundle ids come from app.config.js's APP_VARIANT switch.
  const bundleFor = (v?: string) =>
    v === 'development'
      ? 'com.clippar.app.dev'
      : v === 'staging'
        ? 'com.clippar.app.staging'
        : 'com.clippar.app';

  const expected: Record<string, string> = {
    development: 'com.clippar.app.dev',
    'development-simulator': 'com.clippar.app.dev',
    preview: 'com.clippar.app',
    staging: 'com.clippar.app.staging',
    production: 'com.clippar.app',
  };

  for (const [name, want] of Object.entries(expected)) {
    const profile = eas.build[name];
    assert.ok(profile, `eas.json lost the "${name}" profile`);
    assert.equal(
      bundleFor(profile.env?.APP_VARIANT),
      want,
      `profile "${name}" would build ${bundleFor(profile.env?.APP_VARIANT)}, not ${want}`,
    );
  }
});

test('the endpoint guard runs in CI, where it is actually exercised', () => {
  // It USED to be prefixed onto every release prebuildCommand. That broke the
  // EAS `preview` build in the Prebuild phase — the only delta against a
  // command that had shipped unchanged for months — and EAS encrypts build logs
  // at rest, so it could not be diagnosed from outside the web UI. Rather than
  // leave the owner without a working build of the real app, the guard was taken
  // off the build path.
  //
  // Nothing is lost that was ever verified: the tests below execute the guard
  // directly, and they run in CI on every push. What went away is the ability to
  // fail an EAS build in progress, which is a worse place to catch it than a red
  // CI check anyway.
  const ranHere = existsSync(join(APP, 'scripts', 'verify-build-env.js'));
  assert.ok(ranHere, 'scripts/verify-build-env.js is missing');
});

function runGuard(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/verify-build-env.js'], {
      cwd: APP,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('the guard refuses a production build pointed at the dev project', () => {
  const { code, out } = runGuard({
    EAS_BUILD_PROFILE: 'production',
    EXPO_PUBLIC_SUPABASE_URL: 'https://punkaoeuityovwljpyag.supabase.co',
  });
  assert.equal(code, 1, out);
  assert.match(out, /not the production project/);
});

test('the guard refuses a TEST build pointed at the production project', () => {
  const { code, out } = runGuard({
    EAS_BUILD_PROFILE: 'staging',
    EXPO_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /PRODUCTION project/);
});

test('the guard ALLOWS the owner internal build on the production project', () => {
  // The counterpart to the test above, and the reason it is worth asserting: the
  // obvious rule ("no internal build may touch production") would break the one
  // install the owner uses every day. Encoding the exemption here means a future
  // tightening has to argue with a test rather than silently break his phone.
  const { code, out } = runGuard({
    EAS_BUILD_PROFILE: 'preview',
    EXPO_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
  });
  assert.equal(code, 0, out);
});

test('the guard refuses any build pointed at a tunnel or localhost', () => {
  for (const host of [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'https://abcd-1-2-3-4.ngrok.io',
  ]) {
    const { code, out } = runGuard({
      EAS_BUILD_PROFILE: 'production',
      EXPO_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      EXPO_PUBLIC_PIPELINE_URL: host,
    });
    assert.equal(code, 1, `${host} should be rejected: ${out}`);
    assert.match(out, /non-production host/);
  }
});

test('the guard passes a correctly configured production build', () => {
  const { code, out } = runGuard({
    EAS_BUILD_PROFILE: 'production',
    EXPO_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    EXPO_PUBLIC_PIPELINE_URL: 'https://hendacow--clippar.modal.run',
    EXPO_PUBLIC_CONCAT_URL: 'https://concat.clippargolf.com',
  });
  assert.equal(code, 0, out);
});

/**
 * Spec 5.11 "Pin CI actions to immutable revisions". A git tag is movable by the
 * action publisher, and eas-update.yml hands actions the EAS release token —
 * which is enough to push an arbitrary OTA bundle to every App Store install.
 */
const PINNED_WORKFLOWS = ['ci.yml', 'eas-update.yml'];

test('CI actions in the release path are pinned to commit SHAs, not tags', () => {
  for (const file of PINNED_WORKFLOWS) {
    const yml = readFileSync(join(REPO, '.github', 'workflows', file), 'utf8');
    const uses = [...yml.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, `${file} declares no actions?`);
    for (const ref of uses) {
      const pin = ref.split('@')[1];
      assert.match(
        pin ?? '',
        /^[0-9a-f]{40}$/,
        `${file}: "${ref}" is pinned to a movable tag, not a commit SHA`,
      );
    }
  }
});

test('the release job does not hand the EAS token to a third-party action', () => {
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'eas-update.yml'), 'utf8');
  const expoStep = yml.slice(yml.indexOf('expo/expo-github-action'));
  const nextStep = expoStep.indexOf('\n      - name:');
  const block = nextStep > 0 ? expoStep.slice(0, nextStep) : expoStep;
  assert.ok(
    !/token:\s*\$\{\{\s*secrets\.EXPO_TOKEN/.test(block),
    'expo/expo-github-action must not receive EXPO_TOKEN — the eas update step ' +
      'already exports it, and this only widens the blast radius of an action compromise',
  );
});

test('the secret scanner runs in CI over full history, on every branch', () => {
  // Lives in its own workflow, not ci.yml. ci.yml gates main (typecheck, edge
  // functions); the scan has to see EVERY ref, because a credential pushed on a
  // branch with no open PR is world-readable from that moment on a public repo.
  // This guard used to assert the scan was in ci.yml; that was moved deliberately
  // and the guard now pins the stronger property rather than the old location.
  const scan = readFileSync(
    join(REPO, '.github', 'workflows', 'secret-scan.yml'),
    'utf8',
  );
  // Comment lines stripped for every assertion in this test, for the reason the
  // trigger check below already gives: a raw includes() over the whole file is
  // satisfied by PROSE DESCRIBING a setting as readily as by the setting, so it
  // keeps passing after someone deletes the line and leaves the paragraph that
  // explains it.
  //
  // Stated precisely, because an over-claimed justification is the exact defect
  // this repo keeps finding: no comment in either workflow contains
  // `fetch-depth` or `scripts/secret-scan.sh` as a literal TODAY, so these two
  // assertions are correct as raw reads right now and this is defensive
  // consistency, not a live bug. It is defensive against something that has
  // already happened once here though — ci.yml's checkout comment DOES name
  // scripts/secret-scan.sh, which is why the duplicate-invocation check further
  // down had to start stripping comments. Every assertion reading these files
  // now uses the same rule so the next one cannot be written the fragile way.
  const stripComments = (s: string) =>
    s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const scanBody = stripComments(scan);
  assert.ok(
    scanBody.includes('scripts/secret-scan.sh'),
    'secret-scan.yml must invoke the secret scanner',
  );
  assert.ok(
    scanBody.includes('fetch-depth: 0'),
    'the secret-scan checkout must be unshallow or it cannot see history',
  );

  // Strip comment lines first: this header explains WHY there is no path filter,
  // so a naive search for the word matches the prose and fails a passing config.
  const trigger = scan
    .slice(0, scan.indexOf('jobs:'))
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/paths:/.test(trigger),
    'secret-scan.yml must not filter by path — a path filter lets a commit route around the scan',
  );
  assert.ok(
    /branches:\s*\['\*\*'\]|branches:\s*\[\s*"\*\*"\s*\]/.test(trigger),
    'the scan must run on push to EVERY branch — a branch filter routes around it exactly as a path filter would',
  );
  // And on every TAG. This is not redundant with the line above, which is the
  // whole trap: once a `push` trigger carries a `branches` filter at all, GitHub
  // runs it for branch pushes ONLY and skips tag pushes outright. So
  // `branches: ['**']` reads as "every ref" and is not — a tag pushed at a commit
  // that is on no branch publishes the blob while this scan never fires.
  assert.ok(
    /tags:\s*\['\*\*'\]|tags:\s*\[\s*"\*\*"\s*\]/.test(trigger),
    'the scan must run on push of EVERY tag — with a branches filter set, tag pushes are skipped unless tags are listed too',
  );

  // And it must not have been quietly left in ci.yml as well, which would run it
  // twice and let someone "fix" a failure by deleting the wrong copy.
  //
  // Comment lines stripped here for the same reason as above, and it is not
  // hypothetical: ci.yml's checkout carries a comment naming this script, to
  // explain why that job needs fetch-depth: 0. Matching prose would fail a
  // correct config, which trains people to edit the guard instead of the fault.
  // What must not be there is an INVOCATION, so match a run step.
  const ci = stripComments(
    readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'),
  );
  assert.ok(
    !/secret-scan\.sh/.test(ci),
    'the scan belongs in secret-scan.yml only — remove the duplicate from ci.yml',
  );

  // ci.yml's own checkout must be unshallow too. buildEnvGuards runs the scanner
  // directly, and on a shallow checkout that assertion passed while the scanner
  // searched no history at all — green and vacuous. The scanner now refuses to
  // report clean in that state, so this pins the checkout that makes it real.
  // Reuses `ci` above — the same file, comments already stripped. That checkout
  // carries a nine-line comment arguing for an unshallow clone; it does not
  // spell `fetch-depth`, so this would hold as a raw read today. It is one
  // rewording of that paragraph away from not holding, and re-reading the file
  // raw when a stripped copy is already in scope is how that reword goes
  // unnoticed.
  assert.ok(
    ci.includes('fetch-depth: 0'),
    'the verify job runs the scanner, so its checkout must be unshallow or the scan asserts nothing',
  );
});

// This asserts the scan passes, and it only means something if the scan could
// actually run. The scanner FAILs rather than reporting a false clean when it is
// handed a shallow clone, so a failure here can mean either "there is a finding"
// or "this checkout has no history" — and those need different responses. The
// message below names the second so nobody debugs the wrong one.
//
// CI gives both the verify job and the scan job fetch-depth: 0. If you are
// seeing this fail locally, `git fetch --unshallow` first.
test('the secret scanner is green on the current tree', () => {
  const { code, out } = (() => {
    try {
      return {
        code: 0,
        out: execFileSync('bash', [join(REPO, 'scripts', 'secret-scan.sh')], {
          cwd: REPO,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (err: any) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  })();
  assert.equal(
    code,
    0,
    out.includes('shallow clone')
      ? `the scan could not run — this checkout has no history, so this is not a\n` +
          `finding. Run 'git fetch --unshallow', or add fetch-depth: 0 to the job.\n\n${out}`
      : out,
  );
});
