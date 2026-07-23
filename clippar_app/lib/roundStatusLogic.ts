/**
 * Canonical round status — pure derivation logic.
 *
 * This is THE single source of truth for "what state is this round's reel
 * in". Home, round detail, and Backup & status all consume the 6-value
 * enum below; no screen may compute reel state any other way.
 *
 * Pure module: no react-native imports, testable under node:test
 * (tests/roundStatus.test.ts). The async parts (file existence checks,
 * URL signing, SQLite stale flag) live in lib/roundStatus.ts, which feeds
 * its results into `deriveRoundStatus` as plain inputs.
 *
 * Vocabulary law (enforced in copy below): "reel"/"build"/"rebuild"/
 * "stitch" only ever mean on-device compose; "backup" only ever means
 * cloud upload; the word "upload" never appears for rendering.
 */

export type RoundStatus =
  | 'READY'
  | 'PROCESSING'
  | 'NEEDS_REBUILD'
  | 'NO_REEL'
  | 'FAILED'
  | 'NO_CONTENT';

/** Legacy `status === 'processing'` rows older than this can never strand
 *  in PROCESSING — they flip to NEEDS_REBUILD (or NO_CONTENT with 0 clips). */
export const PROCESSING_STALE_MS = 10 * 60 * 1000;

/** Any PROCESSING state with no progress signal for this long flips to
 *  FAILED with cause "Rendering didn't finish". */
export const COMPOSE_WATCHDOG_MS = 30_000;

export interface RoundStatusInput {
  /** rounds.reel_url — null if never exported */
  reelUrl: string | null;
  /**
   * Whether reelUrl resolves to a playable source (signable https/storage
   * path, or a file:// that exists on disk). `null` = unknown (e.g. the
   * device is offline and the URL couldn't be signed) — treated as
   * playable so an offline session never scares the user into a rebuild.
   */
  reelPlayable: boolean | null;
  /** Local stale flag — clips changed since the reel was composed. */
  reelStale: boolean;
  /** rounds.status from Supabase (e.g. 'ready' | 'processing' | 'failed'). */
  status: string | null;
  /** rounds.updated_at ISO string (used for the 10-min staleness rule). */
  updatedAt: string | null;
  /** Kept clips for this round. */
  clipsCount: number;
  /** An active LOCAL COMPOSE job for this round (via the pipeline
   *  broadcaster). Backup-queue activity never sets this. */
  hasActiveComposeJob: boolean;
  /** Last compose attempt for this round errored, or the 30s compose
   *  watchdog fired. */
  composeFailed: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

export function deriveRoundStatus(input: RoundStatusInput): RoundStatus {
  const now = input.now ?? Date.now();

  // FAILED wins: an explicit failure is always surfaced with a retry.
  if (input.composeFailed || input.status === 'failed') return 'FAILED';

  // Active local compose broadcast — always live PROCESSING.
  if (input.hasActiveComposeJob) return 'PROCESSING';

  // Server-side 'processing' rows are only trusted while fresh.
  const isProcessingRow = input.status === 'processing';
  const processingFresh =
    isProcessingRow &&
    input.updatedAt != null &&
    now - Date.parse(input.updatedAt) < PROCESSING_STALE_MS;
  if (processingFresh) return 'PROCESSING';

  if (input.reelUrl) {
    // reelPlayable === null (offline/unknown) is treated as playable.
    if (input.reelPlayable !== false && !input.reelStale) return 'READY';
    // Stale flag set, dead file:// path, or unsignable.
    return 'NEEDS_REBUILD';
  }

  // Legacy processing rows older than 10 min: the staleness rule.
  if (isProcessingRow) {
    return input.clipsCount > 0 ? 'NEEDS_REBUILD' : 'NO_CONTENT';
  }

  if (input.clipsCount > 0) return 'NO_REEL';
  return 'NO_CONTENT';
}

// ────────────────────────────────────────────────────────────
// Status chip metadata (colors are theme token NAMES — resolved
// against constants/theme.ts by components/shared/StatusChip.tsx)
// ────────────────────────────────────────────────────────────

export type StatusColorToken =
  | 'processing'
  | 'accentGold'
  | 'textSecondary'
  | 'accentRed'
  | 'textTertiary';

export interface StatusChipMeta {
  label: string;
  colorToken: StatusColorToken;
}

/**
 * Chip label + color for a status. READY returns null — the thumbnail +
 * play glyph IS the ready signal, no chip.
 */
export function getStatusChipMeta(
  status: RoundStatus,
  clipsCount: number,
  composePercent?: number | null,
): StatusChipMeta | null {
  switch (status) {
    case 'READY':
      return null;
    case 'PROCESSING':
      return {
        label:
          composePercent != null
            ? `Building reel… ${Math.round(composePercent)}%`
            : 'Building reel…',
        colorToken: 'processing',
      };
    case 'NEEDS_REBUILD':
      return { label: 'Needs rebuild', colorToken: 'accentGold' };
    case 'NO_REEL':
      return {
        label: `${clipsCount} clip${clipsCount === 1 ? '' : 's'} — no reel yet`,
        colorToken: 'textSecondary',
      };
    case 'FAILED':
      return { label: "Didn't finish", colorToken: 'accentRed' };
    case 'NO_CONTENT':
      return { label: 'No highlights', colorToken: 'textTertiary' };
  }
}

// ────────────────────────────────────────────────────────────
// Failure causes (H9 — always a human cause, never a raw code)
// ────────────────────────────────────────────────────────────

export const FAILURE_CAUSE = {
  didNotFinish: "Rendering didn't finish",
  missingClips: "Some clips couldn't be found",
  notEnoughFootage: 'Not enough footage to build a reel',
} as const;

export type FailureCause = (typeof FAILURE_CAUSE)[keyof typeof FAILURE_CAUSE];

/** Classify a raw compose error message into one of the three causes. */
export function composeFailureCause(message: string | null | undefined): FailureCause {
  if (!message) return FAILURE_CAUSE.didNotFinish;
  if (/no\s+playable|no\s+clips|not\s+enough/i.test(message)) {
    return FAILURE_CAUSE.notEnoughFootage;
  }
  if (/clip|missing|not\s+found|no\s+such\s+file|couldn'?t\s+be\s+found|unrecoverable/i.test(message)) {
    return FAILURE_CAUSE.missingClips;
  }
  return FAILURE_CAUSE.didNotFinish;
}

// ────────────────────────────────────────────────────────────
// Date formatting (H6 — relative <7 days, absolute after)
// ────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Today" / "Yesterday" / weekday name for the last 7 days, absolute
 * "12 Jul" after that.
 */
export function formatRoundDate(dateIso: string, now: number = Date.now()): string {
  const d = new Date(dateIso);
  if (isNaN(d.getTime())) return '';
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);

  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return WEEKDAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function formatScoreToPar(scoreToPar: number): string {
  if (scoreToPar === 0) return 'E';
  return scoreToPar > 0 ? `+${scoreToPar}` : `${scoreToPar}`;
}

/**
 * List-row meta line: "Yesterday · 18 holes · 12 clips · +6".
 * Omits parts that are unknown.
 */
export function formatRoundMeta(
  round: {
    date: string;
    holes_played?: number | null;
    clips_count?: number | null;
    score_to_par?: number | null;
  },
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  const dateLabel = formatRoundDate(round.date, now);
  if (dateLabel) parts.push(dateLabel);
  if (round.holes_played != null && round.holes_played > 0) {
    parts.push(`${round.holes_played} holes`);
  }
  if (round.clips_count != null) {
    parts.push(`${round.clips_count} clip${round.clips_count === 1 ? '' : 's'}`);
  }
  if (typeof round.score_to_par === 'number') {
    parts.push(formatScoreToPar(round.score_to_par));
  }
  return parts.join(' · ');
}
