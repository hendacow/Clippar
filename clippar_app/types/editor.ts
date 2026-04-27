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
 * Precedence:
 * 1. If the user has explicitly set trim bounds (trimStartMs > 0 OR
 *    trimEndMs !== -1), honour them — that's the user's most recent choice.
 * 2. Otherwise, if auto-trim detected a swing window (autoTrimStartMs /
 *    autoTrimEndMs are set), default the handles to that window.
 * 3. Otherwise, fall back to the full clip (0 .. durationMs).
 *
 * The user can always drag handles outward to include more of the original
 * video — the auto-trim window is the *starting* position, not a hard cap.
 */
export function getInitialTrimBounds(
  clip: Pick<EditorClip, 'trimStartMs' | 'trimEndMs' | 'autoTrimStartMs' | 'autoTrimEndMs'>,
  durationMs: number,
): { startMs: number; endMs: number } {
  const userCustomized = clip.trimStartMs > 0 || clip.trimEndMs !== -1;
  if (userCustomized) {
    return {
      startMs: clip.trimStartMs,
      endMs: clip.trimEndMs === -1 ? durationMs : clip.trimEndMs,
    };
  }
  if (clip.autoTrimStartMs !== undefined && clip.autoTrimEndMs !== undefined) {
    return {
      startMs: Math.max(0, clip.autoTrimStartMs),
      endMs: Math.min(durationMs, clip.autoTrimEndMs),
    };
  }
  return { startMs: 0, endMs: durationMs };
}
