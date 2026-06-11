import { useState, useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getClipUrl } from '@/lib/r2';
import { detectAndTrim, deleteFile, getMemoryStats, detectBallLaunch, renderTracer, getCameraFovDeg, type ShotTypeClassification, type DetectionStrategy } from 'shot-detector';
import { precheckArcGeometry, buildArcSpec, isTracerSkip, type TracerGeometryInput, type TracerSkipReason, type TracerMeta } from '@/lib/tracerMath';
import { logDetection } from '@/lib/detectionLog';
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

        // Tracer fan-out: sourceUri is the single URI everything consumes
        // (preview playback, thumbnails, per-hole save/share, multi-select
        // reels, full composeReel), so swapping it here covers all of them.
        // The tracer file is a same-duration re-encode of the trimmed file,
        // which keeps isPreTrimmed/full-range semantics valid. F14: a 'done'
        // row whose cache file was evicted is downgraded to 'stale' (and
        // sourceUri restored) by processAllTracers' existence guard.
        const tracerReady =
          config.tracer.enabled && c.tracer_status === 'done' && !!c.tracer_file_uri;

        return {
          id: String(c.id),
          type: 'shot' as const,
          holeNumber: c.hole_number,
          shotNumber: c.shot_number,
          sourceUri: tracerReady ? c.tracer_file_uri : c.file_uri,
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
          // Populated only when the feature flag is on — Supabase-loaded
          // clips never have these and consumers treat absence as "no tracer".
          tracerUri: config.tracer.enabled ? c.tracer_file_uri ?? undefined : undefined,
          tracerStatus: config.tracer.enabled ? c.tracer_status ?? undefined : undefined,
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
      // Reordering changes the composed reel's clip sequence — mark stale.
      if (storage && state.roundId) {
        storage.markReelStale(state.roundId).catch(() => {});
      }
    },
    [state.roundId]
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

  // Move a clip to a different hole (scorecard screen's "Move to hole"
  // action). Updates the in-memory section grouping immediately and
  // persists the new hole_number to SQLite. The moved clip lands at the
  // end of the destination hole's shot order.
  const moveClipToHole = useCallback(
    (clipId: string, targetHoleNumber: number) => {
      setState((prev) => {
        // Locate the clip and its current hole.
        let moved: EditorClip | undefined;
        for (const h of prev.holes) {
          const found = h.clips.find((c) => c.id === clipId);
          if (found) {
            moved = found;
            break;
          }
        }
        if (!moved || moved.holeNumber === targetHoleNumber) return prev;

        // Next shot number on the target hole.
        const targetHole = prev.holes.find((h) => h.holeNumber === targetHoleNumber);
        const nextShot =
          (targetHole?.clips.reduce((m, c) => Math.max(m, c.shotNumber), 0) ?? 0) + 1;
        const movedUpdated: EditorClip = {
          ...moved,
          holeNumber: targetHoleNumber,
          shotNumber: nextShot,
        };

        // Rebuild holes: drop from source, append to target (create the
        // target section if it doesn't exist yet), keep sections sorted.
        let holes = prev.holes.map((h) => ({
          ...h,
          clips: h.clips.filter((c) => c.id !== clipId),
        }));

        if (holes.some((h) => h.holeNumber === targetHoleNumber)) {
          holes = holes.map((h) =>
            h.holeNumber === targetHoleNumber
              ? {
                  ...h,
                  clips: [...h.clips, movedUpdated].sort(
                    (a, b) => a.shotNumber - b.shotNumber
                  ),
                }
              : h
          );
        } else {
          holes = [
            ...holes,
            {
              holeNumber: targetHoleNumber,
              par: DEFAULT_PAR,
              strokes: 1,
              scoreToPar: 1 - DEFAULT_PAR,
              clips: [movedUpdated],
            },
          ];
        }
        holes.sort((a, b) => a.holeNumber - b.holeNumber);

        return { ...prev, holes };
      });

      // Persist to SQLite (clip ids are the numeric row id as a string).
      const numId = Number(clipId);
      if (Number.isInteger(numId) && storage && state.roundId) {
        storage
          .updateClipHole(numId, targetHoleNumber, state.roundId)
          .catch(() => {});
      }
    },
    [state.roundId]
  );

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
        // Mark this round's reel as stale so the round detail page
        // surfaces a "Re-compose reel" button — the user's trim
        // edits won't be in the saved reel until they re-compose.
        storage.markReelStale(state.roundId).catch(() => {});
      }
    },
    [state.roundId]
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
        storage!.markReelStale(state.roundId).catch(() => {});
      }, 0);
    }
  }, [state.roundId]);

  // ---- Lazy trim processing ----

  // Cancellation flag — set to true when the editor unmounts to abort background processing
  const trimCancelledRef = useRef(false);
  // Same pattern for the shot-tracer batch (processAllTracers).
  const tracerCancelledRef = useRef(false);

  // Clean up on unmount: cancel any in-progress trim/tracer processing
  useEffect(() => {
    return () => {
      trimCancelledRef.current = true;
      tracerCancelledRef.current = true;
    };
  }, []);

  /**
   * Resolve the active trim window (pre/post roll) for the import pipeline.
   *
   * FIX #8 — full-swing window must win over a stale saved override.
   * The DEFAULT is now config.trim.windows.fullSwing (2500/1500, ~4s total),
   * NOT the legacy defaultPreRollMs/defaultPostRollMs (3000/2000). A saved
   * 'trim_settings' override is only honored when the user EXPLICITLY opted into
   * the new window (parsed.window === 'fullSwing'). Overrides written before this
   * change carry no `window` marker (or carry the old 3000/2000 numbers), so they
   * are intentionally ignored here — otherwise they would silently shadow the new
   * fullSwing window. Kept identical to useCamera.loadTrimSettings so import and
   * live record trim to the same length.
   */
  const getTrimSettings = useCallback(async (): Promise<{
    preRollMs: number;
    postRollMs: number;
  }> => {
    let { preRollMs, postRollMs } = config.trim.windows.fullSwing;
    if (storage) {
      try {
        const saved = await storage.getSetting('trim_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          // Only an explicit fullSwing-tagged override may replace the config window.
          if (parsed.window === 'fullSwing') {
            if (parsed.preRollMs) preRollMs = parsed.preRollMs;
            if (parsed.postRollMs) postRollMs = parsed.postRollMs;
          }
        }
      } catch {}
    }
    // Tracer hook (no-op at the default 0): a longer post-impact window keeps
    // more ball flight in the trimmed clip for the arc draw-on. Gated on
    // config.tracer.enabled so day-zero behavior is byte-identical. Mirrored
    // in useCamera.loadTrimSettings so live record matches import re-trims.
    if (config.tracer.enabled && config.tracer.extraPostRollMs > 0) {
      postRollMs += config.tracer.extraPostRollMs;
    }
    return { preRollMs, postRollMs };
  }, []);

  /**
   * Resolve the configured detection strategy + options-JSON for the import
   * pipeline's detectAndTrim calls.
   *
   * FIX #4 — keep the velocityPeak dense pass enabled on the import path. Imports
   * are not latency-critical (background batch in the editor), so when the active
   * strategy is 'velocityPeak' we force `refine: true` in the forwarded options to
   * request the native dense second pass. Other strategies pass options untouched.
   */
  const resolveDetection = useCallback((): {
    strategy: DetectionStrategy;
    optionsJson: string;
  } => {
    const strategy = config.detection.strategy;
    const options: Record<string, unknown> = { ...(config.detection.options ?? {}) };
    if (strategy === 'velocityPeak') {
      options.refine = true;
    }
    return { strategy, optionsJson: JSON.stringify(options) };
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
      const { strategy, optionsJson } = resolveDetection();

      try {
        const result = await detectAndTrim(
          originalSourceUri,
          preRollMs,
          postRollMs,
          [],
          strategy,
          optionsJson
        );
        // A/B harness (additive, non-fatal): record a structured row.
        void logDetection(clipId, result).catch(() => {});

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
    [state.holes, getTrimSettings, resolveDetection, updateClipInState]
  );

  /**
   * Process all untrimmed clips in the background, one at a time.
   * Called once on editor mount. Respects cancellation via trimCancelledRef.
   */
  const processAllUntrimmed = useCallback(async () => {
    // Reset cancellation flag in case the hook is re-used
    trimCancelledRef.current = false;

    const { preRollMs, postRollMs } = await getTrimSettings();
    // Configured strategy + options for the whole batch (fix #4: velocityPeak
    // dense pass via options.refine is enabled on this import path inside
    // resolveDetection).
    const { strategy, optionsJson } = resolveDetection();

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
          recentForHole,
          strategy,
          optionsJson
        );
        // A/B harness (additive, non-fatal): record a structured row.
        void logDetection(clip.id, result).catch(() => {});

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
  }, [state.holes, getTrimSettings, resolveDetection, updateClipInState]);

  // ---- Shot-tracer batch (config.tracer) ----

  /**
   * Render GPS-anchored tracer arcs onto every eligible clip. Sibling of
   * processAllUntrimmed with the same batch discipline: sequential,
   * cancellable via tracerCancelledRef, mark-failed-and-continue. Runs
   * AFTER auto-trim settles (editor.tsx gates on untrimmedCount === 0) —
   * pairing and render both need the final trimmed files.
   *
   * Reads rows straight from SQLite: the pairing inputs (GPS, heading,
   * pitch, accuracy) are not part of EditorClip. Idempotent via
   * tracer_status — 'done'/'skipped' rows are untouched, NULL/'stale'
   * (re-)render, 'pending' (a previous session died mid-clip) restarts,
   * 'failed' is retried at most once more (attempts in tracer_meta), then
   * left failed.
   *
   * Per clip, gates run in F5 order: ALL pure-TS geometry gates (pairing,
   * carry/accuracy band, bearing-vs-heading, anim window) BEFORE the
   * full-resolution Vision pass, so a clip that will skip anyway never pays
   * for detectBallLaunch.
   */
  const processAllTracers = useCallback(async () => {
    if (!config.tracer.enabled || !storage || !roundId) return;
    const db = storage;
    tracerCancelledRef.current = false;

    const rows = await db.getClipsForRound(roundId).catch(() => null);
    if (!rows || rows.length === 0) return;

    // F14 existence guard: iOS can evict tracer_<UUID>.mp4 from caches while
    // SQLite still says 'done'. Downgrade those rows to 'stale' (and point
    // playback back at the trimmed file) BEFORE the batch, so an evicted
    // file is re-rendered this pass instead of black-screening the clip or
    // failing composeReel on a missing input.
    const FileSystem =
      require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    for (const row of rows) {
      if (row.tracer_status !== 'done' || !row.tracer_file_uri) continue;
      let exists = false;
      try {
        exists = (await FileSystem.getInfoAsync(row.tracer_file_uri)).exists;
      } catch {}
      if (exists) continue;
      row.tracer_status = 'stale';
      row.tracer_file_uri = null;
      await db
        .updateClipTracer(row.id, { tracer_file_uri: null, tracer_status: 'stale' })
        .catch(() => {});
      updateClipInState(String(row.id), (c) => ({
        ...c,
        tracerUri: undefined,
        tracerStatus: 'stale',
        sourceUri: row.file_uri,
      }));
    }

    const parseMeta = (s: string | null): { attempts?: number; [k: string]: unknown } => {
      if (!s) return {};
      try {
        return JSON.parse(s) ?? {};
      } catch {
        return {};
      }
    };

    const candidates = rows.filter((row) => {
      if (row.needs_trim === 1) return false; // defensive — batch runs post-trim
      if (row.is_excluded === 1) return false; // not played/composed; status stays NULL for a later re-include
      if (row.tracer_status === 'done' || row.tracer_status === 'skipped') return false;
      if (row.tracer_status === 'failed') {
        return (parseMeta(row.tracer_meta).attempts ?? 1) < 2; // one retry, then leave failed
      }
      return true; // NULL | 'stale' | 'pending'
    });
    if (candidates.length === 0) return;

    try {
      const stats = await getMemoryStats();
      console.log(
        `[TRACER] === START: ${candidates.length} clip(s) to trace ===\n` +
        `[TRACER] Available: ${stats.availableMemoryMB}MB | Used: ${stats.usedMemoryMB}MB | Free disk: ${stats.freeDiskMB}MB`
      );
    } catch {}

    // One native FOV read per batch — the lens is constant per device.
    let hFovLandscapeDeg: number = config.tracer.cameraHFovLandscapeDeg;
    try {
      hFovLandscapeDeg = (await getCameraFovDeg()) ?? hFovLandscapeDeg;
    } catch {}

    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i];
      const clipId = String(row.id);

      if (tracerCancelledRef.current) {
        console.log('[TRACER] Batch cancelled (unmount)');
        return;
      }

      const persistSkip = async (reason: TracerSkipReason, meta: Partial<TracerMeta>) => {
        await db
          .updateClipTracer(row.id, {
            tracer_status: 'skipped',
            tracer_meta: JSON.stringify({ ...meta, reason }),
          })
          .catch(() => {});
        updateClipInState(clipId, (c) => ({ ...c, tracerStatus: 'skipped' }));
        console.log(
          `[TRACER] hole=${row.hole_number} shot=${row.shot_number} SKIP reason=${reason}`
        );
      };

      try {
        // ── Pure-TS gate ladder (F5) ──
        // Pairing (F16): the IMMEDIATE successor in (hole_number, sort_order,
        // shot_number) order — getClipsForRound's ORDER BY — and same hole
        // ONLY (the next hole's tee is not this shot's landing spot). Never
        // scan past a GPS-less clip looking for a later fix.
        const idx = rows.findIndex((r) => r.id === row.id);
        const next = rows[idx + 1];
        const successor = next && next.hole_number === row.hole_number ? next : null;

        // debugForceTrace: ignore the classifier so street tests (no club/
        // ball → fallback-classified 'putt') still exercise the full pipeline.
        if (row.shot_type === 'putt' && !config.tracer.debugForceTrace) {
          await persistSkip('putt', {});
          continue;
        }
        // debugForceTrace: no detected impact → anchor on the clip midpoint so
        // the arc still renders (timing will be approximate, fine for testing).
        let impactMs = row.impact_time_ms;
        if (impactMs === null && config.tracer.debugForceTrace) {
          impactMs = Math.max(0, Math.round(((row.duration_seconds ?? 0) * 1000) / 2));
          console.log(
            `[TRACER] hole=${row.hole_number} shot=${row.shot_number} debugForceTrace: no impact_time_ms, using clip midpoint ${impactMs}ms`
          );
        }
        if (impactMs === null) {
          await persistSkip('no-impact', {});
          continue;
        }
        // Own fix missing → the pairing has no start point; same bucket as a
        // missing landing fix (the meta flag disambiguates for diagnostics).
        if (row.gps_latitude === null || row.gps_longitude === null) {
          await persistSkip('no-next-gps', { missingOwnGps: true });
          continue;
        }
        if (
          !successor ||
          successor.gps_latitude === null ||
          successor.gps_longitude === null
        ) {
          await persistSkip('no-next-gps', {});
          continue;
        }

        const geomInput: TracerGeometryInput = {
          latN: row.gps_latitude,
          lonN: row.gps_longitude,
          latN1: successor.gps_latitude,
          lonN1: successor.gps_longitude,
          gpsAccuracyMN: row.gps_accuracy_m,
          gpsAccuracyMN1: successor.gps_accuracy_m,
          cameraHeadingDeg: row.camera_heading_deg,
          cameraHeadingCalibration: row.camera_heading_calibration,
          cameraPitchDownDeg: row.camera_pitch_deg,
          hFovLandscapeDeg,
          clipDurationSec: row.duration_seconds ?? 0,
          impactTimeMs: impactMs,
          autoTrimStartMs: row.auto_trim_start_ms,
        };

        const pre = precheckArcGeometry(geomInput);
        if (isTracerSkip(pre)) {
          await persistSkip(pre.skip, pre.meta);
          continue;
        }

        // Geometry gates passed — now the clip is worth the full-res Vision
        // pass. 'pending' drives the per-clip "Tracing..." badge and the F17
        // export/save/share gating in editor.tsx.
        await db.updateClipTracer(row.id, { tracer_status: 'pending' }).catch(() => {});
        updateClipInState(clipId, (c) => ({ ...c, tracerStatus: 'pending' }));

        // Detect on the ORIGINAL file when available (it has more
        // post-impact footage); impact_time_ms is already on that timeline.
        // On the trimmed file the impact shifts back by the auto-trim start.
        const detectUri = row.original_file_uri ?? row.file_uri;
        const detectImpactMs = row.original_file_uri
          ? impactMs
          : impactMs - (row.auto_trim_start_ms ?? 0);

        const detection = await detectBallLaunch(detectUri, detectImpactMs);
        if (tracerCancelledRef.current) return;

        // Detection-dependent gates (F3 no-heading vision-or-skip, F8a
        // grounded veto, F8b direction conflict) + arc synthesis.
        const arc = buildArcSpec({ ...geomInput, detection });
        if (isTracerSkip(arc)) {
          await persistSkip(arc.skip, arc.meta);
          continue;
        }

        // Render onto the TRIMMED file — animStartSec is on its timeline.
        const { tracerUri } = await renderTracer(row.file_uri, JSON.stringify(arc.spec));
        if (!tracerUri) {
          // Older native binary without renderTracerOnClip — graceful null.
          throw new Error('renderTracer unavailable (native rebuild required)');
        }

        await db
          .updateClipTracer(row.id, {
            tracer_file_uri: tracerUri,
            tracer_status: 'done',
            tracer_meta: JSON.stringify(arc.meta),
            tracer_rendered_at: new Date().toISOString(),
          })
          .catch(() => {});
        // Live fan-out: sourceUri is the single consumed URI, so pointing it
        // at the tracer file covers playback/save/share/compose immediately
        // (no reload needed). Same mapping as loadFromLocal.
        updateClipInState(clipId, (c) => ({
          ...c,
          tracerUri,
          tracerStatus: 'done',
          sourceUri: tracerUri,
        }));

        console.log(
          `[TRACER] hole=${row.hole_number} shot=${row.shot_number} DONE ` +
          `method=${arc.meta.method} carryM=${arc.meta.carryM} deltaDeg=${arc.meta.deltaDeg} ` +
          `uri=...${tracerUri.slice(-32)}`
        );
        try {
          const after = await getMemoryStats();
          console.log(
            `[TRACER] Clip ${i + 1}/${candidates.length} AFTER: Available: ${after.availableMemoryMB}MB | Used: ${after.usedMemoryMB}MB | Free disk: ${after.freeDiskMB}MB`
          );
        } catch {}
      } catch (err) {
        console.warn(`[useEditorState] Tracer failed for clip ${row.id}:`, err);
        // Mark failed and continue — one bad clip must not wedge the batch.
        // attempts counts total failures; the candidate filter above allows
        // exactly one retry (attempts < 2) on a later editor open.
        const attempts = (parseMeta(row.tracer_meta).attempts ?? 0) + 1;
        await db
          .updateClipTracer(row.id, {
            tracer_status: 'failed',
            tracer_meta: JSON.stringify({ ...parseMeta(row.tracer_meta), attempts }),
          })
          .catch(() => {});
        updateClipInState(clipId, (c) => ({ ...c, tracerStatus: 'failed' }));
      }
    }

    console.log('[TRACER] === Batch complete ===');
  }, [roundId, updateClipInState]);

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
    moveClipToHole,
    updateTrim,
    updateClipDuration,
    setIntro,
    setOutro,
    toggleExclude,
    getAllClipsInOrder,
    trimClip,
    processAllUntrimmed,
    processAllTracers,
  };
}
