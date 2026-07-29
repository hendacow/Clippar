import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('the endpoint guard is wired into every release prebuildCommand', () => {
  // The failure this guards against is the one that matters most: a guard that
  // exists in the repo and is never invoked.
  for (const [name, profile] of Object.entries(eas.build)) {
    if (!profile.prebuildCommand) continue;
    assert.ok(
      profile.prebuildCommand.includes('scripts/verify-build-env.js'),
      `profile "${name}" runs a prebuildCommand that does not invoke ` +
        'scripts/verify-build-env.js',
    );
  }
  // ...and at least the store profile must have one at all.
  assert.ok(
    eas.build.production.prebuildCommand?.includes('scripts/verify-build-env.js'),
    'the production profile must run the endpoint guard',
  );
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

test('the secret scanner runs in CI over full history', () => {
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(
    ci.includes('scripts/secret-scan.sh'),
    'ci.yml must invoke the secret scanner',
  );
  assert.ok(
    ci.includes('fetch-depth: 0'),
    'the secret-scan checkout must be unshallow or it cannot see history',
  );
  assert.ok(
    !/^on:[\s\S]*?paths:/m.test(ci.slice(0, ci.indexOf('jobs:'))),
    'ci.yml must not filter by path — a path filter lets a commit route around the secret scan',
  );
});

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
  assert.equal(code, 0, out);
});
