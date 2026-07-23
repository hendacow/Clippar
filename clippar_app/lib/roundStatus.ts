/**
 * Canonical round status — async computation layer.
 *
 * Wraps the pure derivation in lib/roundStatusLogic.ts with the async
 * inputs it needs: reel-source resolution (file existence / URL signing,
 * memoized per session in lib/resolveReelSource.ts) and the local
 * SQLite stale flag.
 *
 * Consumed by Home, round detail, and Backup & status. No screen may
 * compute reel state any other way.
 */
import { Platform } from 'react-native';
import {
  deriveRoundStatus,
  type RoundStatus,
} from '@/lib/roundStatusLogic';
import { resolveReelSource, type ReelSource } from '@/lib/resolveReelSource';

export * from '@/lib/roundStatusLogic';
export { resolveReelSource, type ReelSource } from '@/lib/resolveReelSource';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

export interface RoundLike {
  id: string;
  reel_url?: string | null;
  status?: string | null;
  updated_at?: string | null;
  clips_count?: number | null;
}

export interface ComposeFlags {
  /** roundId of an active local compose job (from the broadcaster). */
  activeComposeRoundId?: string | null;
  /** roundId of the last failed compose attempt (broadcaster/watchdog). */
  failedComposeRoundId?: string | null;
}

export interface RoundStatusResult {
  status: RoundStatus;
  /** Resolved playable source (uri + playable/offline flags). */
  source: ReelSource;
  reelStale: boolean;
}

async function getReelStale(roundId: string): Promise<boolean> {
  if (!isNative) return false;
  try {
    const storage = require('@/lib/storage') as typeof import('@/lib/storage');
    return await storage.isReelStale(roundId);
  } catch {
    return false;
  }
}

/**
 * Compute the canonical status for one round. All I/O (file existence,
 * URL signing, SQLite stale flag) happens here — callers render from the
 * precomputed result and never do per-render I/O.
 */
export async function computeRoundStatus(
  round: RoundLike,
  flags: ComposeFlags = {},
): Promise<RoundStatusResult> {
  const [source, reelStale] = await Promise.all([
    resolveReelSource(round.reel_url ?? null),
    getReelStale(round.id),
  ]);

  const status = deriveRoundStatus({
    reelUrl: round.reel_url ?? null,
    reelPlayable: source.playable,
    reelStale,
    status: round.status ?? null,
    updatedAt: round.updated_at ?? null,
    clipsCount: round.clips_count ?? 0,
    hasActiveComposeJob: flags.activeComposeRoundId === round.id,
    composeFailed: flags.failedComposeRoundId === round.id,
  });

  return { status, source, reelStale };
}

/** Batch variant for lists — resolves in parallel. */
export async function computeRoundStatuses(
  rounds: RoundLike[],
  flags: ComposeFlags = {},
): Promise<Map<string, RoundStatusResult>> {
  const entries = await Promise.all(
    rounds.map(async (r) => [r.id, await computeRoundStatus(r, flags)] as const),
  );
  return new Map(entries);
}
