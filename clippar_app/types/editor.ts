export interface EditorClip {
  id: string;
  type: 'shot' | 'intro' | 'outro';
  holeNumber: number;
  shotNumber: number;
  sourceUri: string | null; // signed URL from Supabase Storage
  storagePath: string | null; // clips/{roundId}/filename
  thumbnailUri?: string;
  trimStartMs: number;
  trimEndMs: number; // -1 = use full duration
  durationMs: number;
  isExcluded?: boolean;
  // Auto-trim metadata
  autoTrimmed?: boolean;
  trimConfidence?: number;
  impactTimeMs?: number;
  originalUri?: string; // original URI before auto-trim
  needsTrim?: boolean; // true if clip was imported but not yet processed by detectAndTrim
  // Auto-trim boundaries in ORIGINAL video milliseconds
  autoTrimStartMs?: number;
  autoTrimEndMs?: number;
}

export interface EditorHoleSection {
  holeNumber: number;
  par: number;
  strokes: number;
  scoreToPar: number;
  clips: EditorClip[];
}

export interface EditorState {
  roundId: string;
  courseName: string;
  holes: EditorHoleSection[];
  intro: EditorClip | null;
  outro: EditorClip | null;
  loading: boolean;
  error: string | null;
}

/**
 * Compute the initial trim handle positions to show in the trim modal.
 *
 * The auto-trim window (autoTrimStartMs / autoTrimEndMs) is defined in the
 * ORIGINAL video's timeline. The trim modal can run in either:
 *   (a) original-timeline mode (durationMs ≈ original duration), or
 *   (b) source-timeline mode (durationMs = pre-trimmed file duration).
 *
 * In mode (a) the auto-trim values fit; in mode (b) they would be
 * out-of-range. We detect mode by checking whether autoTrimEndMs <=
 * durationMs — only then are the auto-trim bounds applicable.
 *
 * Precedence:
 * 1. If the user customized trim AND the values fit the timeline, honour
 *    them — that's the user's most recent choice.
 * 2. Otherwise, if auto-trim bounds fit, default the handles there.
 * 3. Otherwise, fall back to the full clip (0 .. durationMs).
 *
 * The user can always drag handles outward — the auto-trim window is the
 * *starting* position, not a hard cap.
 */
export function getInitialTrimBounds(
  clip: Pick<EditorClip, 'trimStartMs' | 'trimEndMs' | 'autoTrimStartMs' | 'autoTrimEndMs'>,
  durationMs: number,
): { startMs: number; endMs: number } {
  // User-customized trim values are valid only when they fit the current
  // timeline. If a clip was auto-trimmed and we're now displaying its
  // trimmed file (shorter timeline), the stored original-timeline bounds
  // would be out of range — skip them and fall through to the file-level
  // defaults below.
  const userCustomized = clip.trimStartMs > 0 || clip.trimEndMs !== -1;
  if (userCustomized) {
    const endCandidate = clip.trimEndMs === -1 ? durationMs : clip.trimEndMs;
    if (clip.trimStartMs <= durationMs && endCandidate <= durationMs) {
      return { startMs: clip.trimStartMs, endMs: endCandidate };
    }
  }
  if (
    clip.autoTrimStartMs !== undefined &&
    clip.autoTrimEndMs !== undefined &&
    clip.autoTrimEndMs <= durationMs
  ) {
    return {
      startMs: Math.max(0, clip.autoTrimStartMs),
      endMs: Math.min(durationMs, clip.autoTrimEndMs),
    };
  }
  return { startMs: 0, endMs: durationMs };
}
