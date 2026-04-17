const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Exclude heavy directories from Metro's file watcher to speed up hot reload.
// Uses Watchman under the hood when available (brew install watchman) — the
// exclusions below trim the file graph Watchman crawls on startup and the
// paths Metro's Node fallback walks when Watchman is absent.
config.watcher = {
  ...config.watcher,
  // Watchman cuts initial crawl time from minutes to sub-second on this repo,
  // but we still tell it what to skip so re-indexes stay fast.
  watchman: {
    ...(config.watcher && config.watcher.watchman),
    // deferStates lets Watchman pause notifications during big git operations
    // (branch switches, rebases) instead of replaying them one-by-one.
    deferStates: ['hg.update', 'hg.transaction'],
  },
  additionalExclusions: [
    // iOS build artifacts (~961MB) — never needs watching
    path.resolve(__dirname, 'ios'),
    // Android build artifacts
    path.resolve(__dirname, 'android'),
    // Xcode derived data that may land here
    '**/DerivedData/**',
    // Distribution builds
    path.resolve(__dirname, 'dist'),
    // Reference app (~38MB of screenshots)
    path.resolve(__dirname, 'golfcam'),
    // Diagnostic / maintenance scripts (Node-only, never imported by RN)
    path.resolve(__dirname, 'scripts'),
    // Supabase migrations (SQL, not RN code)
    path.resolve(__dirname, 'supabase'),
    // Planning / notes / git internals — large and churny
    path.resolve(__dirname, '.planning'),
    path.resolve(__dirname, '.claude'),
    path.resolve(__dirname, '.git'),
    // EAS / Expo build caches
    path.resolve(__dirname, '.eas'),
    // Test & coverage output
    path.resolve(__dirname, 'coverage'),
    // macOS metadata that causes spurious watcher events
    '**/.DS_Store',
  ],
};

// resolver.blockList is enforced during module resolution regardless of
// whether Watchman is the active file watcher — a safety net so the excluded
// dirs above can never accidentally enter the Metro dependency graph.
const exclusionRegex = new RegExp(
  [
    `${path.resolve(__dirname, 'ios')}/.*`,
    `${path.resolve(__dirname, 'android')}/.*`,
    `${path.resolve(__dirname, 'golfcam')}/.*`,
    `${path.resolve(__dirname, 'scripts')}/.*`,
    `${path.resolve(__dirname, 'supabase')}/.*`,
    `${path.resolve(__dirname, 'dist')}/.*`,
    `${path.resolve(__dirname, '.planning')}/.*`,
    `${path.resolve(__dirname, '.claude')}/.*`,
    `${path.resolve(__dirname, '.eas')}/.*`,
  ].join('|'),
);
config.resolver = {
  ...config.resolver,
  blockList: exclusionRegex,
};

// Cache compiled modules on disk across runs so warm starts skip re-transform.
config.cacheStores = config.cacheStores || [];

// Allow Metro to use more worker threads on multi-core Macs (default is
// (cpus - 1), but Metro under-counts on Apple Silicon when LLM workloads are
// running). Setting it explicitly gives stable parallelism.
const os = require('os');
config.maxWorkers = Math.max(2, Math.min(8, os.cpus().length - 1));

module.exports = withNativeWind(config, { input: './global.css' });
