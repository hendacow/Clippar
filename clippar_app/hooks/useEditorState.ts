import { useState, useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getClipUrl } from '@/lib/r2';
import { detectAndTrim, deleteFile, getMemoryStats, type ShotTypeClassification } from 'shot-detector';
import { config } from '@/constants/config';
import type { EditorClip, EditorHoleSection, EditorState } from '@/types/editor';

const DEFAULT_PAR = 4;
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// Conditionally import local storage (only works on native with expo-sqlite)
let storage: typeof import('@/lib/storage') | null = null;
if (isNative) {
  storage = require('@/lib/storage') as typeof import('@/lib/storage');
}

function buildHoleSections(
  clips: EditorClip[],
  scores: { hole_number: number; strokes: number; par: number }[],
  courseHolePars: Record<number, number>
): EditorHoleSection[] {
  // Group clips by hole
  const holeMap = new Map<number, EditorClip[]>();
  clips.forEach((clip) => {
    const existing = holeMap.get(clip.holeNumber) ?? [];
    existing.push(clip);
    holeMap.set(clip.holeNumber, existing);
  });

  // Collect all hole numbers from clips and scores
  const allHoleNumbers = new Set<number>();
  clips.forEach((c) => allHoleNumbers.add(c.holeNumber));
  scores.forEach((s) => allHoleNumbers.add(s.hole_number));

  const scoreMap = new Map(scores.map((s) => [s.hole_number, s]));
  const sortedHoles = [...allHoleNumbers].sort((a, b) => a - b);

  return sortedHoles.map((holeNum) => {
    const score = scoreMap.get(holeNum);
    const par = score?.par ?? courseHolePars[holeNum] ?? DEFAULT_PAR;
    const strokes = score?.strokes ?? (holeMap.get(holeNum)?.length ?? 0);

    return {
      holeNumber: holeNum,
      par,
      strokes,
      scoreToPar: strokes - par,
      clips: (holeMap.get(holeNum) ?? []).sort(
        (a, b) => a.shotNumber - b.shotNumber
      ),
    };
  });
}

export function useEditorState(roundId: string | undefined) {
  const [state, setState] = useState<EditorState>({
    roundId: roundId ?? '',
    courseName: '',
    holes: [],
    intro: null,
    outro: null,
    loading: true,
    error: null,
  });

  // Try loading from Supabase (remote shots table)
  const loadFromSupabase = useCallback(async (): Promise<boolean> => {
    if (!roundId) return false;

    try {
      const { data: round, error: roundErr } = await supabase
        .from('rounds')
        .select('*, shots(*)')
        .eq('id', roundId)
        .single();

      if (roundErr || !round) return false;

      // Fetch scores
      let scores: { hole_number: number; strokes: number; par: number }[] = [];
      try {
        const { data } = await supabase
          .from('scores')
          .select('hole_number, strokes, par')
          .eq('round_id', roundId)
          .order('hole_number');
        if (data) scores = data;
      } catch {}

      // Fetch course hole pars
      let courseHolePars: Record<number, number> = {};
      if (round.course_id) {
        try {
          const { data: holeData } = await supabase
            .from('holes')
            .select('hole_number, par')
            .eq('course_id', round.course_id)
            .order('hole_number');
          if (holeData) {
            holeData.forEach((h) => {
              courseHolePars[h.hole_number] = h.par;
            });
          }
        } catch {}
      }

      const shots = (round.shots ?? []) as {
        id: string;
        hole_number: number;
        shot_number: number;
        clip_url: string | null;
      }[];

      // Filter out shots with empty clip_url (import pre-creates shots with clip_url=''
      // before the reel-upload step; without this filter those rows become black
      // unplayable cards in the editor).
      const realShots = shots.filter((s) => s.clip_url && s.clip_url.trim() !== '');
      if (realShots.length < shots.length) {
        console.log(
          `[useEditorState] Skipped ${shots.length - realShots.length} shot(s) with empty clip_url`
        );
      }

      // Generate signed URLs for all remaining clips
      const clips = await Promise.all(
        realShots.map(async (shot): Promise<EditorClip> => {
          let sourceUri: string | null = null;
          if (shot.clip_url) {
            sourceUri = await getClipUrl(shot.clip_url);
            if (!sourceUri) {
              console.warn(
                `[useEditorState] Hole ${shot.hole_number} shot ${shot.shot_number}: getClipUrl returned null for "${shot.clip_url}"`
              );
            }
          }
          return {
            id: shot.id,
            type: 'shot',
            holeNumber: shot.hole_number,
            shotNumber: shot.shot_number,
            sourceUri,
            storagePath: shot.clip_url,
            trimStartMs: 0,
            trimEndMs: -1,
            durationMs: 0,
          };
        })
      );

      // Need at least scores or clips to consider this a valid load
      if (clips.length === 0 && scores.length === 0) return false;

      const holes = buildHoleSections(clips, scores, courseHolePars);

      setState({
        roundId,
        courseName: round.course_name ?? '',
        holes,
        intro: null,
        outro: null,
        loading: false,
        error: null,
      });
      return true;
    } catch {
      return false;
    }
  }, [roundId]);

  // Fall back to local SQLite storage (where clips actually live on phone)
  const loadFromLocal = useCallback(async (): Promise<boolean> => {
    if (!roundId || !storage) return false;

    try {
      const localRound = await storage.getLocalRound(roundId);
      if (!localRound) return false;

      const localScores = await storage.getLocalScores(roundId);
      const localClips = await storage.getClipsForRound(roundId);

      const scores = localScores.map((s) => ({
        hole_number: s.hole_number,
        strokes: s.strokes,
        par: s.par,
      }));

      const clips: EditorClip[] = localClips.map((c) => {
        const rawDurationMs = (c.duration_seconds ?? 0) * 1000;
        const trimStart = c.trim_start_ms ?? 0;
        const trimEnd = c.trim_end_ms ?? -1;

        // Trim offsets are now always relative to the ORIGINAL video.
        // The trimmer uses originalUri for the timeline and these offsets
        // mark where the handles should be positioned.

        return {
          id: String(c.id),
          type: 'shot' as const,
          holeNumber: c.hole_number,
          shotNumber: c.shot_number,
          sourceUri: c.file_uri,
          storagePath: c.uploaded
            ? `${roundId}/hole${c.hole_number}_shot${c.shot_number}_${c.id}.mp4`
            : null,
          trimStartMs: trimStart,
          trimEndMs: trimEnd,
          durationMs: rawDurationMs,
          isExcluded: (c.is_excluded ?? 0) === 1,
          autoTrimmed: c.auto_trimmed === 1,
          originalUri: c.original_file_uri ?? undefined,
          needsTrim: c.needs_trim === 1 && c.auto_trimmed !== 1,
          autoTrimStartMs: c.auto_trim_start_ms ?? undefined,
          autoTrimEndMs: c.auto_trim_end_ms ?? undefined,
        };
      });

      // Fetch course hole pars if course_id exists
      let courseHolePars: Record<number, number> = {};
      if (localRound.course_id) {
        try {
          const { data: holeData } = await supabase
            .from('holes')
            .select('hole_number, par')
            .eq('course_id', localRound.course_id)
            .order('hole_number');
          if (holeData) {
            holeData.forEach((h) => {
              courseHolePars[h.hole_number] = h.par;
            });
          }
        } catch {}
      }

      const holes = buildHoleSections(clips, scores, courseHolePars);

      setState({
        roundId,
        courseName: localRound.course_name,
        holes,
        intro: null,
        outro: null,
        loading: false,
        error: null,
      });
      return true;
    } catch {
      return false;
    }
  }, [roundId]);

  const loadRound = useCallback(async () => {
    if (!roundId) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    // On native, try local SQLite first (clips live here after import/record)
    if (isNative) {
      const localOk = await loadFromLocal();
      if (localOk) return;
    }

    // Try Supabase (for web, or if local has no clips)
    const supabaseOk = await loadFromSupabase();
    if (supabaseOk) return;

    // Last resort: try local on web too (shouldn't happen but safe)
    if (!isNative) {
      const localOk = await loadFromLocal();
      if (localOk) return;
    }

    // Both failed
    setState((prev) => ({
      ...prev,
      loading: false,
      error: 'Round not found. Record a round first to use the editor.',
    }));
  }, [roundId, loadFromSupabase, loadFromLocal]);

  useEffect(() => {
    loadRound();
  }, [loadRound]);

  // ---- Mutations ----

  const reorderClips = useCallback(
    (holeNumber: number, reorderedClips: EditorClip[]) => {
      setState((prev) => ({
        ...prev,
        holes: prev.holes.map((h) =>
          h.holeNumber === holeNumber ? { ...h, clips: reorderedClips } : h
        ),
      }));
    },
    []
  );

  const removeClip = useCallback((clipId: string) => {
    setState((prev) => ({
      ...prev,
      holes: prev.holes.map((h) => ({
        ...h,
        clips: h.clips.filter((c) => c.id !== clipId),
      })),
    }));
  }, []);

  const updateTrim = useCallback(
    (
      clipId: string,
      trimStartMs: number,
      trimEndMs: number,
      sourceOverride?: { sourceUri: string; durationMs: number },
    ) => {
      setState((prev) => ({
        ...prev,
        holes: prev.holes.map((h) => ({
          ...h,
          clips: h.clips.map((c) => {
            if (c.id !== clipId) return c;
            const updated = { ...c, trimStartMs, trimEndMs };
            if (sourceOverride) {
              updated.sourceUri = sourceOverride.sourceUri;
              updated.durationMs = sourceOverride.durationMs;
            }
            return updated;
          }),
        })),
      }));
      // Persist to SQLite
      const numId = parseInt(clipId, 10);
      if (!isNaN(numId) && storage) {
        const dbUpdates: Parameters<typeof storage.updateClipEditorState>[1] = {
          trim_start_ms: trimStartMs,
          trim_end_ms: trimEndMs,
        };
        if (sourceOverride) {
          dbUpdates.file_uri = sourceOverride.sourceUri;
          dbUpdates.duration_seconds = sourceOverride.durationMs / 1000;
        }
        storage.updateClipEditorState(numId, dbUpdates).catch(() => {});
      }
    },
    []
  );

  const updateClipDuration = useCallback(
    (clipId: string, durationMs: number) => {
      setState((prev) => ({
        ...prev,
        holes: prev.holes.map((h) => ({
          ...h,
          clips: h.clips.map((c) =>
            c.id === clipId ? { ...c, durationMs } : c
          ),
        })),
      }));
    },
    []
  );

  const setIntro = useCallback((clip: EditorClip | null) => {
    setState((prev) => ({ ...prev, intro: clip }));
  }, []);

  const setOutro = useCallback((clip: EditorClip | null) => {
    setState((prev) => ({ ...prev, outro: clip }));
  }, []);

  const toggleExclude = useCallback((clipId: string) => {
    let newExcluded = false;
    setState((prev) => {
      const next = {
        ...prev,
        holes: prev.holes.map((h) => ({
          ...h,
          clips: h.clips.map((c) => {
            if (c.id === clipId) {
              newExcluded = !c.isExcluded;
              return { ...c, isExcluded: newExcluded };
            }
            return c;
          }),
        })),
      };
      return next;
    });
    // Persist to SQLite
    const numId = parseInt(clipId, 10);
    if (!isNaN(numId) && storage) {
      // Use setTimeout to ensure state has settled
      setTimeout(() => {
        storage!.updateClipEditorState(numId, { is_excluded: newExcluded }).catch(() => {});
      }, 0);
    }
  }, []);

  // ---- Lazy trim processing ----

  // Cancellation flag — set to true when the editor unmounts to abort background processing
  const trimCancelledRef = useRef(false);

  // Clean up on unmount: cancel any in-progress trim processing
  useEffect(() => {
    return () => {
      trimCancelledRef.current = true;
    };
  }, []);

  /** Load user's trim settings (pre/post roll) from SQLite, falling back to config defaults. */
  const getTrimSettings = useCallback(async (): Promise<{
    preRollMs: number;
    postRollMs: number;
  }> => {
    let preRollMs = config.trim.defaultPreRollMs;
    let postRollMs = config.trim.defaultPostRollMs;
    if (storage) {
      try {
        const saved = await storage.getSetting('trim_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.preRollMs) preRollMs = parsed.preRollMs;
          if (parsed.postRollMs) postRollMs = parsed.postRollMs;
        }
      } catch {}
    }
    return { preRollMs, postRollMs };
  }, []);

  /** Helper: update a single clip in React state by ID */
  const updateClipInState = useCallback(
    (clipId: string, updater: (clip: EditorClip) => EditorClip) => {
      setState((prev) => ({
        ...prev,
        holes: prev.holes.map((h) => ({
          ...h,
          clips: h.clips.map((c) => (c.id === clipId ? updater(c) : c)),
        })),
      }));
    },
    []
  );

  /**
   * Trim a single clip that hasn't been processed yet.
   * Calls detectAndTrim, updates React state + SQLite.
   */
  const trimClip = useCallback(
    async (clipId: string): Promise<EditorClip | null> => {
      // Find the clip across all holes
      let clip: EditorClip | undefined;
      for (const hole of state.holes) {
        clip = hole.clips.find((c) => c.id === clipId);
        if (clip) break;
      }
      if (!clip || !clip.sourceUri) return null;

      // If already trimmed or doesn't need trim, return as-is
      if (!clip.needsTrim) return clip;

      const originalSourceUri = clip.sourceUri;
      const { preRollMs, postRollMs } = await getTrimSettings();

      try {
        const result = await detectAndTrim(originalSourceUri, preRollMs, postRollMs);

        const updatedClip: EditorClip = {
          ...clip,
          needsTrim: false,
          autoTrimmed: true,
        };

        if (result.found && result.trimmedUri) {
          updatedClip.sourceUri = result.trimmedUri;
          updatedClip.originalUri = originalSourceUri;
          // Store trim offsets relative to the ORIGINAL video
          updatedClip.trimStartMs = result.trimStartMs;
          updatedClip.trimEndMs = result.trimEndMs;
          updatedClip.autoTrimStartMs = result.trimStartMs;
          updatedClip.autoTrimEndMs = result.trimEndMs;
          updatedClip.trimConfidence = result.confidence;
          updatedClip.impactTimeMs = result.impactTimeMs;
        }

        // Update React state
        updateClipInState(clipId, () => updatedClip);

        // Persist to SQLite
        const numId = parseInt(clipId, 10);
        if (!isNaN(numId) && storage) {
          if (result.found && result.trimmedUri) {
            await storage
              .markClipTrimmed(
                numId,
                result.trimmedUri,
                result.impactTimeMs,
                result.confidence,
                result.trimStartMs,
                result.trimEndMs
              )
              .catch(() => {});
            // Persist trim offsets (relative to original) + shot type
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: result.trimStartMs,
                trim_end_ms: result.trimEndMs,
                shot_type: result.shotType,
              })
              .catch(() => {});
          } else if (result.found && !result.trimmedUri && result.shotType === 'putt') {
            // Putt — no trim file created (full clip kept), but persist classification
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: 0,
                trim_end_ms: -1,
                shot_type: 'putt',
              })
              .catch(() => {});
            await storage
              .markClipTrimmed(numId, originalSourceUri, result.impactTimeMs, result.confidence)
              .catch(() => {});
          } else {
            // No swing found — mark as processed anyway so we don't retry
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: 0,
                trim_end_ms: -1,
              })
              .catch(() => {});
            await storage
              .markClipTrimmed(numId, originalSourceUri, null, null)
              .catch(() => {});
          }
        }

        // Keep the original file — the trimmer needs it for full-timeline editing.

        return updatedClip;
      } catch (err) {
        console.warn(`[useEditorState] trimClip failed for ${clipId}:`, err);
        return null;
      }
    },
    [state.holes, getTrimSettings, updateClipInState]
  );

  /**
   * Process all untrimmed clips in the background, one at a time.
   * Called once on editor mount. Respects cancellation via trimCancelledRef.
   */
  const processAllUntrimmed = useCallback(async () => {
    // Reset cancellation flag in case the hook is re-used
    trimCancelledRef.current = false;

    const { preRollMs, postRollMs } = await getTrimSettings();

    // Collect all clips that need trimming across all holes
    const untrimmedClips: EditorClip[] = [];
    for (const hole of state.holes) {
      for (const clip of hole.clips) {
        if (clip.needsTrim && clip.sourceUri) {
          untrimmedClips.push(clip);
        }
      }
    }

    if (untrimmedClips.length === 0) return;

    // Log initial memory stats
    try {
      const initialStats = await getMemoryStats();
      console.log(
        `[MEMORY] === START: ${untrimmedClips.length} clips to process ===\n` +
        `[MEMORY] Available: ${initialStats.availableMemoryMB}MB | Used: ${initialStats.usedMemoryMB}MB | Free disk: ${initialStats.freeDiskMB}MB | Caches: ${initialStats.cachesDirMB}MB`
      );
    } catch {}

    // Track the last few shot classifications per-hole so the 3-tier classifier
    // gets inter-clip context (e.g. recent putts → lean the next ambiguous clip putt).
    const recentByHole = new Map<number, ShotTypeClassification[]>();

    for (let clipIdx = 0; clipIdx < untrimmedClips.length; clipIdx++) {
      const clip = untrimmedClips[clipIdx];

      // Check for cancellation before each clip
      if (trimCancelledRef.current) {
        console.log('[useEditorState] Trim processing cancelled (unmount)');
        return;
      }

      try {
        // Log memory BEFORE each clip
        try {
          const before = await getMemoryStats();
          console.log(
            `[MEMORY] Clip ${clipIdx + 1}/${untrimmedClips.length} BEFORE: Available: ${before.availableMemoryMB}MB | Used: ${before.usedMemoryMB}MB | Free disk: ${before.freeDiskMB}MB`
          );
          // CRASH WARNING: if available memory drops below 200MB
          if (before.availableMemoryMB > 0 && before.availableMemoryMB < 200) {
            console.warn(`[MEMORY] ⚠️ LOW MEMORY WARNING: Only ${before.availableMemoryMB}MB available! iOS may kill the app soon.`);
          }
        } catch {}

        const recentForHole = recentByHole.get(clip.holeNumber) ?? [];
        const result = await detectAndTrim(
          clip.sourceUri!,
          preRollMs,
          postRollMs,
          recentForHole
        );

        // Record this clip's classification for future siblings on the same hole (keep last 3).
        if (result.found) {
          const next = [...recentForHole, result.shotType].slice(-3);
          recentByHole.set(clip.holeNumber, next);
        }

        // Check cancellation again after the async call
        if (trimCancelledRef.current) return;

        const updatedClip: EditorClip = {
          ...clip,
          needsTrim: false,
          autoTrimmed: true,
        };

        const originalSourceUri = clip.sourceUri!;

        if (result.found && result.trimmedUri) {
          updatedClip.sourceUri = result.trimmedUri;
          updatedClip.originalUri = originalSourceUri;
          // Store trim offsets relative to the ORIGINAL video (for full-timeline trimmer)
          updatedClip.trimStartMs = result.trimStartMs;
          updatedClip.trimEndMs = result.trimEndMs;
          updatedClip.autoTrimStartMs = result.trimStartMs;
          updatedClip.autoTrimEndMs = result.trimEndMs;
          updatedClip.trimConfidence = result.confidence;
          updatedClip.impactTimeMs = result.impactTimeMs;
        }

        // Update React state
        updateClipInState(clip.id, () => updatedClip);

        // Persist to SQLite
        const numId = parseInt(clip.id, 10);
        if (!isNaN(numId) && storage) {
          if (result.found && result.trimmedUri) {
            await storage
              .markClipTrimmed(
                numId,
                result.trimmedUri,
                result.impactTimeMs,
                result.confidence,
                result.trimStartMs,
                result.trimEndMs
              )
              .catch(() => {});
            // Also persist trim offsets (relative to original) + shot type
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: result.trimStartMs,
                trim_end_ms: result.trimEndMs,
                shot_type: result.shotType,
              })
              .catch(() => {});
          } else if (result.found && !result.trimmedUri && result.shotType === 'putt') {
            // Putt — no trim file created (full clip kept), but persist classification
            await storage
              .markClipTrimmed(numId, originalSourceUri, result.impactTimeMs, result.confidence)
              .catch(() => {});
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: 0,
                trim_end_ms: -1,
                shot_type: 'putt',
              })
              .catch(() => {});
          } else {
            await storage
              .markClipTrimmed(numId, originalSourceUri, null, null)
              .catch(() => {});
          }
        }

        // Keep the original file — the trimmer needs it for full-timeline editing.
        // Original cleanup is now manual via settings.

        // Log memory AFTER each clip (including cleanup)
        try {
          const after = await getMemoryStats();
          console.log(
            `[MEMORY] Clip ${clipIdx + 1}/${untrimmedClips.length} AFTER:  Available: ${after.availableMemoryMB}MB | Used: ${after.usedMemoryMB}MB | Free disk: ${after.freeDiskMB}MB` +
            ` | ${result.found ? 'TRIMMED' : 'no swing'} (hole ${clip.holeNumber}, shot ${clip.shotNumber})`
          );
        } catch {}

        // VERBOSE TRIM DETAIL — exposes what detectAndTrim actually returned
        // and what got persisted, so we can diagnose why durations look wrong.
        // Shows: shot type, swing window (in original timeline), confidence,
        // whether a trim file was actually created, and the final URI.
        const trimWindowMs =
          result.found && typeof result.trimEndMs === 'number' && typeof result.trimStartMs === 'number'
            ? result.trimEndMs - result.trimStartMs
            : null;
        console.log(
          `[TRIM] hole=${clip.holeNumber} shot=${clip.shotNumber} ` +
          `found=${result.found} ` +
          `shotType=${result.shotType ?? 'unknown'} ` +
          `confidence=${result.confidence ?? 'n/a'} ` +
          `impactMs=${result.impactTimeMs ?? 'n/a'} ` +
          `window=${result.trimStartMs ?? '?'}..${result.trimEndMs ?? '?'} ` +
          `(${trimWindowMs ?? '?'}ms) ` +
          `trimmedFileCreated=${!!result.trimmedUri} ` +
          `finalUri=${(result.trimmedUri ?? originalSourceUri).slice(-40)}`,
        );
      } catch (err) {
        console.warn(
          `[useEditorState] Failed to process clip ${clip.id}:`,
          err
        );
        // Log memory even on failure
        try {
          const errStats = await getMemoryStats();
          console.log(
            `[MEMORY] Clip ${clipIdx + 1}/${untrimmedClips.length} FAILED: Available: ${errStats.availableMemoryMB}MB | Used: ${errStats.usedMemoryMB}MB`
          );
        } catch {}
        // CRITICAL: mark the failed clip as processed so it doesn't block the
        // "Auto-trimming X of Y" spinner forever and doesn't keep Export/Preview
        // disabled. Without this, one bad clip wedges the entire editor.
        const numId = parseInt(clip.id, 10);
        if (!isNaN(numId) && storage) {
          try {
            await storage.markClipTrimmed(numId, clip.sourceUri!, null, null);
          } catch {}
        }
        updateClipInState(clip.id, (c) => ({
          ...c,
          needsTrim: false,
          autoTrimmed: false,
        }));
        // Continue with next clip — don't abort the whole batch
      }
    }

    console.log('[useEditorState] All untrimmed clips processed');
  }, [state.holes, getTrimSettings, updateClipInState]);

  // Get all clips in playback order: intro → hole clips in order → outro
  // Excluded clips are skipped
  const getAllClipsInOrder = useCallback((): EditorClip[] => {
    const ordered: EditorClip[] = [];
    if (state.intro) ordered.push(state.intro);
    state.holes.forEach((h) => {
      ordered.push(...h.clips.filter((c) => !c.isExcluded));
    });
    if (state.outro) ordered.push(state.outro);
    return ordered;
  }, [state.intro, state.holes, state.outro]);

  return {
    state,
    reload: loadRound,
    reorderClips,
    removeClip,
    updateTrim,
    updateClipDuration,
    setIntro,
    setOutro,
    toggleExclude,
    getAllClipsInOrder,
    trimClip,
    processAllUntrimmed,
  };
}
