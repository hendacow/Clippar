/**
 * The scorecard payload handed to native `composeReel`, i.e. the exact
 * numbers the EXPORTED reel's card draws.
 *
 * Henry's rule: "the same scorecard that's on the preview is the exact same
 * I want on the export reel." So the reel's card must obey the same display
 * rules as the round-preview overlay (app/round/preview.tsx) — and those
 * rules live in lib/scoreDisplay.ts:
 *
 *   - a hole shows NO score until it was actually ENDED (`hasScore`), never
 *     because playback happens to have passed it;
 *   - TOTAL sums COMPLETED holes only. `strokes` on an unfinished hole is
 *     the clip-count fallback from buildHoleSections and must never reach a
 *     total; before any hole is finished the card shows "-" and no +/- chip.
 *
 * The old payload summed every hole in the round, so a reel could proudly
 * print a total made partly of holes the golfer never ended. This module is
 * the single place that arithmetic happens, and it delegates to
 * `completedTotals` rather than re-deriving it.
 *
 * Pure and native-free so the node test runner can exercise it directly
 * (tests/reelScorecard.test.ts).
 */
import { completedTotals, type DisplayHole } from '@/lib/scoreDisplay';
import type { ScorecardData, ScorecardHole } from '@/modules/shot-detector';

export interface ReelScorecardHole extends DisplayHole {
  holeNumber: number;
  /**
   * Playable duration of this hole's clips in the finished reel, in ms
   * (excluded clips already dropped, trims already applied). Native uses the
   * running start/end to know which hole's state to show at which timestamp.
   */
  durationMs: number;
}

/** The only clip fields the reel timeline arithmetic needs. */
export interface ReelClipTiming {
  isExcluded?: boolean;
  autoTrimmed?: boolean;
  originalUri?: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
  /** The window whose export actually produced `sourceUri`. See below. */
  autoTrimStartMs?: number;
  autoTrimEndMs?: number;
}

/**
 * How much of the finished reel one hole occupies, in ms.
 *
 * `isInReel` decides which clips actually made it into the composition. That
 * predicate is the whole point of this function, and getting it wrong is not
 * a cosmetic error: native picks which hole's scorecard to draw over a shot by
 * matching that shot's position in the reel against these cumulative
 * start/end ranges (`fastGroupSegments` in ShotDetectorModule.swift, and the
 * CALayer fade times on the legacy path). Count a clip here that is NOT in the
 * reel and every hole boundary after it sits later than the video really is,
 * so shots start showing an earlier hole's card — and the error accumulates
 * for the rest of the reel.
 *
 * The editor drops clips whose file is missing from disk and could not be
 * re-downloaded, which iOS makes an ordinary event rather than a rare one, so
 * "included" and "not excluded" are genuinely different sets.
 *
 * Each clip must contribute EXACTLY what `composeClips` in app/round/editor.tsx
 * asks native to play of it — the two numbers are read against each other, and
 * anything else is drift that compounds down the reel. That contract is why the
 * arithmetic below mirrors the `isPreTrimmed` split in `composeClips` rather
 * than trusting any single cached field.
 */
export function holeReelDurationMs<T extends ReelClipTiming>(
  clips: readonly T[],
  isInReel: (clip: T) => boolean,
): number {
  let total = 0;
  for (const clip of clips) {
    if (clip.isExcluded || !isInReel(clip)) continue;
    const isPreTrimmed = !!(clip.autoTrimmed && clip.originalUri);
    let dur: number;
    if (isPreTrimmed) {
      // sourceUri IS the trim file and composeClips sends native 0..-1, so the
      // contribution is that file's WHOLE length, however the bounds read.
      //
      // Two fields claim to know that length and each is stale in a different
      // situation, so neither can be trusted alone:
      //
      //   • `durationMs` is stale for the whole session that auto-trimmed the
      //     clips. useEditorState swaps sourceUri to the trim file in React
      //     state but never refreshes durationMs; only SQLite gets the
      //     corrected value, and nothing reloads the editor between auto-trim
      //     and Export. So on an ordinary round it is the UNTRIMMED recording,
      //     many times too long, for every clip.
      //
      //   • the trim window's WIDTH is stale after a re-trim that FAILED.
      //     ClipTrimModal.handleSave saves the user's newly chosen bounds
      //     without a sourceOverride when trimVideo throws ("saving offsets
      //     only"), so the bounds describe a file that was never written while
      //     sourceUri still points at the previous trim — which is what native
      //     plays in full.
      //
      // `autoTrimStartMs`/`autoTrimEndMs` are the record of which window
      // actually produced sourceUri, and nothing but a real trim rewrites them
      // (updateClipEditorState only ever touches trim_start_ms/trim_end_ms).
      // So the width is the file's length exactly while the bounds still ARE
      // that window; once they diverge, the manual re-trim path is in charge
      // and it maintains durationMs itself (successfully via sourceOverride,
      // or by leaving both sourceUri and durationMs untouched on failure).
      const boundsMatchTrimFile =
        clip.autoTrimStartMs !== undefined &&
        clip.autoTrimEndMs !== undefined &&
        clip.trimStartMs === clip.autoTrimStartMs &&
        clip.trimEndMs === clip.autoTrimEndMs;
      dur = boundsMatchTrimFile
        ? clip.autoTrimEndMs! - clip.autoTrimStartMs!
        : clip.durationMs;
    } else {
      // sourceUri is the full recording and composeClips forwards the bounds
      // verbatim, so native plays [trimStartMs, trimEndMs) of it. An open end
      // means "to the end of the file" — it does NOT undo the start handle, so
      // trimStartMs is subtracted either way.
      const endMs = clip.trimEndMs === -1 ? clip.durationMs : clip.trimEndMs;
      dur = endMs - clip.trimStartMs;
    }
    total += Math.max(0, dur);
  }
  return total;
}

export function buildReelScorecard(
  courseName: string,
  holes: readonly ReelScorecardHole[],
): ScorecardData {
  let cumulativeMs = 0;
  const payloadHoles: ScorecardHole[] = holes.map((hole) => {
    const startMs = cumulativeMs;
    cumulativeMs += Math.max(0, hole.durationMs);
    return {
      holeNumber: hole.holeNumber,
      par: hole.par,
      strokes: hole.strokes,
      hasScore: hole.hasScore,
      startMs,
      endMs: cumulativeMs,
    };
  });

  // Completed holes only — same helper the preview card uses.
  const totals = completedTotals(holes);

  return {
    courseName: courseName || 'Round',
    totalPar: totals?.par ?? 0,
    totalStrokes: totals?.strokes ?? 0,
    holesCompleted: totals?.holesCompleted ?? 0,
    holes: payloadHoles,
  };
}
