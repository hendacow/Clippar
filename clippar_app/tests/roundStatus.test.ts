import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRoundStatus,
  getStatusChipMeta,
  composeFailureCause,
  formatRoundDate,
  formatRoundMeta,
  formatScoreToPar,
  FAILURE_CAUSE,
  PROCESSING_STALE_MS,
  type RoundStatusInput,
} from '../lib/roundStatusLogic';

const NOW = Date.parse('2026-07-23T10:00:00Z');

function input(overrides: Partial<RoundStatusInput> = {}): RoundStatusInput {
  return {
    reelUrl: null,
    reelPlayable: null,
    reelStale: false,
    status: 'ready',
    updatedAt: null,
    clipsCount: 0,
    hasActiveComposeJob: false,
    composeFailed: false,
    now: NOW,
    ...overrides,
  };
}

// ── READY ──────────────────────────────────────────────────

test('playable non-stale reel is READY', () => {
  assert.equal(
    deriveRoundStatus(input({ reelUrl: 'reels/a.mp4', reelPlayable: true, clipsCount: 5 })),
    'READY',
  );
});

test('unknown playability (offline) is treated as READY, not NEEDS_REBUILD', () => {
  assert.equal(
    deriveRoundStatus(input({ reelUrl: 'reels/a.mp4', reelPlayable: null, clipsCount: 5 })),
    'READY',
  );
});

// ── PROCESSING ─────────────────────────────────────────────

test('active local compose job is PROCESSING regardless of row state', () => {
  assert.equal(
    deriveRoundStatus(
      input({ hasActiveComposeJob: true, reelUrl: 'reels/a.mp4', reelPlayable: true }),
    ),
    'PROCESSING',
  );
});

test('fresh server processing row is PROCESSING', () => {
  assert.equal(
    deriveRoundStatus(
      input({
        status: 'processing',
        updatedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
        clipsCount: 3,
      }),
    ),
    'PROCESSING',
  );
});

// ── NEEDS_REBUILD (the staleness rules) ────────────────────

test('legacy processing row older than 10 min with clips is NEEDS_REBUILD, never eternal PROCESSING', () => {
  assert.equal(
    deriveRoundStatus(
      input({
        status: 'processing',
        updatedAt: new Date(NOW - PROCESSING_STALE_MS - 1000).toISOString(),
        clipsCount: 3,
      }),
    ),
    'NEEDS_REBUILD',
  );
});

test('legacy processing row with no updated_at and no clips falls to NO_CONTENT', () => {
  assert.equal(
    deriveRoundStatus(input({ status: 'processing', updatedAt: null, clipsCount: 0 })),
    'NO_CONTENT',
  );
});

test('stale flag forces NEEDS_REBUILD even when reel is playable', () => {
  assert.equal(
    deriveRoundStatus(
      input({ reelUrl: 'reels/a.mp4', reelPlayable: true, reelStale: true, clipsCount: 4 }),
    ),
    'NEEDS_REBUILD',
  );
});

test('dead file:// reel (reinstall case) is NEEDS_REBUILD, never a broken poster', () => {
  assert.equal(
    deriveRoundStatus(
      input({ reelUrl: 'file:///gone.mp4', reelPlayable: false, clipsCount: 4 }),
    ),
    'NEEDS_REBUILD',
  );
});

// ── FAILED ─────────────────────────────────────────────────

test('server failed status wins over reel checks', () => {
  assert.equal(
    deriveRoundStatus(input({ status: 'failed', reelUrl: 'reels/a.mp4', reelPlayable: true })),
    'FAILED',
  );
});

test('compose failure (error or watchdog) is FAILED', () => {
  assert.equal(deriveRoundStatus(input({ composeFailed: true, clipsCount: 2 })), 'FAILED');
});

// ── NO_REEL / NO_CONTENT ───────────────────────────────────

test('kept clips but no reel_url is NO_REEL', () => {
  assert.equal(deriveRoundStatus(input({ clipsCount: 7 })), 'NO_REEL');
});

test('zero kept clips is NO_CONTENT', () => {
  assert.equal(deriveRoundStatus(input({ clipsCount: 0 })), 'NO_CONTENT');
});

// ── Chips ──────────────────────────────────────────────────

test('READY has no chip — the thumbnail is the ready signal', () => {
  assert.equal(getStatusChipMeta('READY', 5), null);
});

test('chip labels and color tokens per the copy sheet', () => {
  assert.deepEqual(getStatusChipMeta('NEEDS_REBUILD', 5), {
    label: 'Needs rebuild',
    colorToken: 'accentGold',
  });
  assert.deepEqual(getStatusChipMeta('NO_REEL', 5), {
    label: '5 clips — no reel yet',
    colorToken: 'textSecondary',
  });
  assert.deepEqual(getStatusChipMeta('FAILED', 5), {
    label: "Didn't finish",
    colorToken: 'accentRed',
  });
  assert.deepEqual(getStatusChipMeta('NO_CONTENT', 0), {
    label: 'No highlights',
    colorToken: 'textTertiary',
  });
});

test('PROCESSING chip shows percent only when a real one exists', () => {
  assert.equal(getStatusChipMeta('PROCESSING', 5)?.label, 'Building reel…');
  assert.equal(getStatusChipMeta('PROCESSING', 5, 62)?.label, 'Building reel… 62%');
});

// ── Failure causes (H9 — human, never a raw code) ──────────

test('failure causes classify raw compose errors', () => {
  assert.equal(composeFailureCause(null), FAILURE_CAUSE.didNotFinish);
  assert.equal(composeFailureCause('AVFoundation error -11800'), FAILURE_CAUSE.didNotFinish);
  assert.equal(composeFailureCause('clip file not found on disk'), FAILURE_CAUSE.missingClips);
  assert.equal(composeFailureCause('No playable clips'), FAILURE_CAUSE.notEnoughFootage);
});

// ── Dates (H6 — relative <7 days, absolute after) ──────────

test('relative dates inside 7 days, absolute after', () => {
  const now = Date.parse('2026-07-23T10:00:00'); // a Thursday
  assert.equal(formatRoundDate('2026-07-23', now), 'Today');
  assert.equal(formatRoundDate('2026-07-22', now), 'Yesterday');
  assert.equal(formatRoundDate('2026-07-18', now), 'Saturday');
  assert.equal(formatRoundDate('2026-07-12', now), '12 Jul');
  assert.equal(formatRoundDate('2026-06-23', now), '23 Jun');
});

test('meta line composes and omits unknown parts', () => {
  const now = Date.parse('2026-07-23T10:00:00');
  assert.equal(
    formatRoundMeta(
      { date: '2026-07-22', holes_played: 18, clips_count: 12, score_to_par: 6 },
      now,
    ),
    'Yesterday · 18 holes · 12 clips · +6',
  );
  assert.equal(
    formatRoundMeta({ date: '2026-07-22', holes_played: null, clips_count: 1 }, now),
    'Yesterday · 1 clip',
  );
});

test('score-to-par formatting', () => {
  assert.equal(formatScoreToPar(0), 'E');
  assert.equal(formatScoreToPar(3), '+3');
  assert.equal(formatScoreToPar(-2), '-2');
});
