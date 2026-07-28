import { useState, useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getClipUrl } from '@/lib/r2';
import { detectAndTrim, deleteFile, getMemoryStats, detectBallLaunch, renderTracer, getCameraFovDeg, type ShotTypeClassification, type DetectionStrategy } from 'shot-detector';
import { precheckArcGeometry, buildArcSpec, isTracerSkip, type TracerGeometryInput, type TracerSkipReason, type TracerMeta } from '@/lib/tracerMath';
import { logDetection } from '@/lib/detectionLog';
import { visionDetectAndTrim } from '@/lib/visionTrim';
import { isTrimInFlight, markTrimInFlight, clearTrimInFlight } from '@/lib/trimInFlight';
import { emitPipelineEvent } from '@/lib/pipelineEvents';
import { config } from '@/constants/config';
import type { EditorClip, EditorHoleSection, EditorState } from '@/types/editor';

const DEFAULT_PAR = 4;
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

// ---- Throttled memory sampling ----
//
// getMemoryStats() is not free: it crosses the bridge, then enumerates the
// caches directory and stats EVERY file in it to compute cachesDirMB — and it
// does that on a `.utility` QoS queue, which the scheduler is entitled to
// starve while the trim workers are hammering the CPU at `.userInitiated`.
// The trim loop used to `await` it twice per clip purely to print a log line,
// so on a 90-clip round that is 180 low-priority round-trips sitting directly
// on the critical path.
//
// One shared sample, reused for up to TTL ms by every caller, with in-flight
// de-duplication so N workers asking at once cause ONE native call. The
// BEFORE/AFTER log lines can now show the same numbers when two workers land
// inside the same window — they are diagnostics, and that is the trade.
type MemorySample = Awaited<ReturnType<typeof getMemoryStats>>;
const MEMORY_SAMPLE_TTL_MS = 1500;
let memorySample: MemorySample | null = null;
let memorySampledAt = 0;
let memorySampleInFlight: Promise<MemorySample | null> | null = null;

async function sampleMemory(
  maxAgeMs: number = MEMORY_SAMPLE_TTL_MS
): Promise<MemorySample | null> {
  if (memorySample && Date.now() - memorySampledAt < maxAgeMs) return memorySample;
  if (memorySampleInFlight) return memorySampleInFlight;
  memorySampleInFlight = getMemoryStats()
    .then((s) => {
      memorySample = s;
      memorySampledAt = Date.now();
      return s;
    })
    .catch(() => null)
    .finally(() => {
      memorySampleInFlight = null;
    });
  return memorySampleInFlight;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  // Cancellation flag for the auto-trim batch. NOTE: it is no longer raised on
  // unmount. Auto-trim is one of the two long jobs the user must be able to walk
  // away from (the other is compose) — killing it when the editor unmounts meant
  // "leave the editor" silently threw away the work in progress, and made the
  // global "N of M trimmed" indicator a lie the moment you navigated. The batch
  // now runs to completion in the background; it persists to SQLite as it goes,
  // registers each clip in lib/trimInFlight so a re-mounted editor can't start a
  // duplicate pass over the same file, and broadcasts trim:* events so the app
  // shell can show progress from anywhere. The flag is kept for future explicit
  // cancellation (a "stop trimming" affordance) and is still honoured by both
  // the worker loop and processOneClip.
  const trimCancelledRef = useRef(false);
  // The shot-tracer batch keeps the old behaviour: it is decorative, gated off
  // by default (config.tracer), and has no global progress surface — so there
  // is nothing to be gained by burning the battery for it off-screen.
  const tracerCancelledRef = useRef(false);

  // Clean up on unmount: cancel in-progress tracer rendering (see above).
  useEffect(() => {
    return () => {
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
        // VISION FIRST, shot-detector as the fallback.
        //
        // swing-vision localizes the swing INSTANT by motion (the club's
        // direction reversal at the top of the backswing, then the downswing
        // spike ~0.20s later) and decides shot-vs-putt by BODY POSE (peak wrist
        // height in torso lengths). That is a different question from the one
        // the older detector asks, and it measured 52/56 on 56 labelled clips.
        //
        // visionDetectAndTrim returns null — never throws — whenever the module
        // or model isn't in this build (Expo Go, web), the native call rejects,
        // or the trim produced no file. In every one of those cases we fall
        // through to the unchanged detectAndTrim path below.
        const result =
          (await visionDetectAndTrim(originalSourceUri, { preRollMs, postRollMs })) ??
          (await detectAndTrim(
            originalSourceUri,
            preRollMs,
            postRollMs,
            [],
            strategy,
            optionsJson
          ));
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

        // The impact instant is meaningful even when NO trim file was made —
        // a full swing in a clip already shorter than the trim window. Kept in
        // sync with what the SQLite branches below persist.
        if (
          result.found &&
          typeof result.impactTimeMs === 'number' &&
          result.impactTimeMs > 0
        ) {
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
            // No swing found — mark as processed anyway so we don't retry.
            // Also reached by a SWING whose clip was already shorter than the
            // trim window; that case carries a real impact instant, so persist
            // it rather than discarding it. See the matching branch in
            // processOneClip for the full rationale. The `> 0` guard keeps the
            // shot-detector fallback's "nothing found" result writing NULL.
            const impactMs =
              result.found &&
              typeof result.impactTimeMs === 'number' &&
              result.impactTimeMs > 0
                ? result.impactTimeMs
                : null;
            await storage
              .updateClipEditorState(numId, {
                trim_start_ms: 0,
                trim_end_ms: -1,
              })
              .catch(() => {});
            await storage
              .markClipTrimmed(
                numId,
                originalSourceUri,
                impactMs,
                impactMs === null ? null : result.confidence ?? null
              )
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

    // Collect all clips that need trimming across all holes. Skip clips
    // whose LIVE-record detectAndTrim pass is still in flight (mid-round
    // "Review round so far" keeps the record screen mounted underneath):
    // running a second detect+trim on the same source file concurrently
    // orphans one trimmed output and doubles native video load. The live
    // pass marks the row trimmed itself; if it fails, the row keeps
    // needs_trim=1 and the next editor visit retries it.
    const untrimmedClips: EditorClip[] = [];
    for (const hole of state.holes) {
      for (const clip of hole.clips) {
        if (clip.needsTrim && clip.sourceUri) {
          const numId = parseInt(clip.id, 10);
          if (!Number.isNaN(numId) && isTrimInFlight(numId)) {
            console.log(`[useEditorState] clip ${clip.id} trim already in flight (live record) — skipping`);
            continue;
          }
          untrimmedClips.push(clip);
        }
      }
    }

    const total = untrimmedClips.length;
    if (total === 0) return;

    // Log initial memory stats. Forced fresh (maxAge 0); the concurrency
    // decision further down reuses this same sample rather than asking twice.
    try {
      const initialStats = await sampleMemory(0);
      if (initialStats) {
        console.log(
          `[MEMORY] === START: ${total} clips to process ===\n` +
          `[MEMORY] Available: ${initialStats.availableMemoryMB}MB | Used: ${initialStats.usedMemoryMB}MB | Free disk: ${initialStats.freeDiskMB}MB | Caches: ${initialStats.cachesDirMB}MB`
        );
      }
    } catch {}

    // Track the last few shot classifications per-hole so the 3-tier classifier
    // gets inter-clip context (e.g. recent putts → lean the next ambiguous clip putt).
    const recentByHole = new Map<number, ShotTypeClassification[]>();

    // Per-clip work, shared by the parallel hole-chains below. `clipIdx` is a
    // start-order counter for log labels (chains interleave, so it no longer
    // matches array position — each clip still gets a unique 1..N label).
    let startedCount = 0;
    const processOneClip = async (clip: EditorClip) => {
      const clipIdx = startedCount++;

      // Check for cancellation before each clip
      if (trimCancelledRef.current) {
        console.log('[useEditorState] Trim processing cancelled');
        return;
      }

      try {
        // Log memory BEFORE each clip. Throttled + shared (see sampleMemory) —
        // this used to be an unconditional native round-trip per clip on a
        // low-priority queue, blocking the worker before it had done any work.
        try {
          const before = await sampleMemory();
          if (before) {
            console.log(
              `[MEMORY] Clip ${clipIdx + 1}/${total} BEFORE: Available: ${before.availableMemoryMB}MB | Used: ${before.usedMemoryMB}MB | Free disk: ${before.freeDiskMB}MB`
            );
            // CRASH WARNING: if available memory drops below 200MB
            if (before.availableMemoryMB > 0 && before.availableMemoryMB < 200) {
              console.warn(`[MEMORY] ⚠️ LOW MEMORY WARNING: Only ${before.availableMemoryMB}MB available! iOS may kill the app soon.`);
            }
          }
        } catch {}

        const recentForHole = recentByHole.get(clip.holeNumber) ?? [];
        // VISION FIRST, shot-detector as the fallback — same rationale as
        // trimClip above: swing-vision finds the swing INSTANT by motion and
        // decides shot-vs-putt by BODY POSE, measured 52/56 on 56 labelled
        // clips. It returns null (never throws) when unavailable or when it
        // finds nothing usable, and we fall through to the unchanged
        // detectAndTrim path below. Note vision ignores recentForHole — it has
        // no inter-clip context — so that lean-heuristic only applies on the
        // fallback path.
        const result =
          (await visionDetectAndTrim(clip.sourceUri!, { preRollMs, postRollMs })) ??
          (await detectAndTrim(
            clip.sourceUri!,
            preRollMs,
            postRollMs,
            recentForHole,
            strategy,
            optionsJson
          ));
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

        // The impact instant is meaningful even when NO trim file was made —
        // a full swing in a clip already shorter than the trim window. Kept in
        // sync with what the SQLite branches below persist.
        if (
          result.found &&
          typeof result.impactTimeMs === 'number' &&
          result.impactTimeMs > 0
        ) {
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
            // "Mark processed, keep the original." Two very different things
            // land here: a genuine NO_SWING, and a SWING in a clip that was
            // ALREADY shorter than the trim window (visionTrim.ts returns
            // found:true, trimmedUri:null, shotType:'swing' for that). The
            // second one HAS a real impact instant and this branch used to
            // throw it away — which also meant processAllTracers later skipped
            // the clip as 'no-impact', because impact_time_ms is the only
            // thing the arc can be anchored on.
            //
            // Guarded on found + a POSITIVE impact so the shot-detector
            // fallback path is untouched: when it reports nothing found it
            // sends impactTimeMs 0, which still writes NULL exactly as before.
            const impactMs =
              result.found &&
              typeof result.impactTimeMs === 'number' &&
              result.impactTimeMs > 0
                ? result.impactTimeMs
                : null;
            await storage
              .markClipTrimmed(
                numId,
                originalSourceUri,
                impactMs,
                impactMs === null ? null : result.confidence ?? null
              )
              .catch(() => {});
          }
        }

        // Keep the original file — the trimmer needs it for full-timeline editing.
        // Original cleanup is now manual via settings.

        // Log memory AFTER each clip (including cleanup)
        try {
          const after = await sampleMemory();
          if (after) {
            console.log(
              `[MEMORY] Clip ${clipIdx + 1}/${total} AFTER:  Available: ${after.availableMemoryMB}MB | Used: ${after.usedMemoryMB}MB | Free disk: ${after.freeDiskMB}MB` +
              ` | ${result.found ? 'TRIMMED' : 'no swing'} (hole ${clip.holeNumber}, shot ${clip.shotNumber})`
            );
          }
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
          const errStats = await sampleMemory();
          if (errStats) {
            console.log(
              `[MEMORY] Clip ${clipIdx + 1}/${total} FAILED: Available: ${errStats.availableMemoryMB}MB | Used: ${errStats.usedMemoryMB}MB`
            );
          }
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
    };

    // ---- Parallel batch orchestration ----
    // Workers pull clips in STRICT round order (hole 1 finishes fully before
    // hole 2 starts, etc.) so the earliest holes become watchable first —
    // Henry's explicit preference over per-hole lanes, which completed the
    // first shot of every hole before finishing any single hole.
    //
    // Tradeoff: the shot-type classifier's recentByHole context becomes
    // BEST-EFFORT — same-hole clips running concurrently don't see each
    // other, only siblings that already completed (processOneClip reads the
    // map at start, appends on finish). It's a lean-heuristic for ambiguous
    // clips, and ordered output is worth the softer context. The native
    // detectAndTrim dispatches onto a CONCURRENT DispatchQueue, so workers
    // genuinely parallelize pose/audio analysis + export across cores.
    const clipQueue = [...untrimmedClips];

    // ---- Adaptive concurrency ----
    //
    // WHAT ACTUALLY BOUNDS THIS, in order:
    //
    //  1. MEMORY. Per clip the peak is the video decoder's working set plus a
    //     couple of decoded 1280px frames plus Core ML / Vision transients.
    //     os_proc_available_memory() is the headroom before jetsam, so the
    //     budget below is expressed directly against it and nothing else.
    //  2. THE NEURAL ENGINE. Both expensive stages of visionDetectAndTrim —
    //     the MobileCLIP2 embeddings and VNDetectHumanBodyPoseRequest — run on
    //     the ANE, which services requests one at a time. Past a handful of
    //     workers the extra clips are queueing on shared silicon, not running,
    //     while still each holding a decoder and frame buffers. That is why
    //     there is a hard cap and why raising it further buys nothing.
    //  3. The hardware video decoder, which serves a limited number of
    //     concurrent sessions and is the other thing every worker needs.
    //
    // NOT the export: trimVideo is AVAssetExportPresetPassthrough, a container
    // remux with no encoder session (ShotDetectorModule.trimVideoPassthrough),
    // so it is neither the memory nor the session bottleneck people assume.
    //
    // NOT MEASURED on device. The cap and the budget are reasoned from the
    // above; what changed underneath them is that swing-vision now scopes its
    // decoded frames with autoreleasepool and holds at most 2 decoded frames at
    // a time (SwingVisionModule / SwingLocalizer.forEachFrame), so per-worker
    // peak is lower and flatter than it was when 3 was chosen.
    const MEM_RESERVE_MB = 300; // never spend the last of the headroom
    const MEM_PER_WORKER_MB = 200;
    const MAX_CONCURRENCY = 4;
    // Below this a worker parks rather than starting another clip.
    const LOW_MEMORY_FLOOR_MB = 350;
    const PARK_MS = 500;

    let concurrency = 2;
    const startStats = await sampleMemory();
    const startMb = startStats?.availableMemoryMB ?? -1;
    if (startMb > 0) {
      concurrency = Math.floor((startMb - MEM_RESERVE_MB) / MEM_PER_WORKER_MB);
    }
    concurrency = Math.max(
      1,
      Math.min(concurrency, MAX_CONCURRENCY, clipQueue.length)
    );
    console.log(
      `[useEditorState] trim batch: ${total} clips in round order, ` +
        `concurrency=${concurrency} (available=${startMb}MB)`
    );

    // Staying adaptive DOWNWARD matters as much as the starting number: the
    // opening reading is taken before a single clip has been decoded, so it
    // says nothing about what this round's clips actually cost. A worker that
    // is about to pick up a new clip while headroom is under the floor parks
    // instead and re-checks. One worker is always exempt, so the queue still
    // drains — worst case the batch degrades to sequential rather than dying.
    let parked = 0;
    let completed = 0;
    const runWorker = async () => {
      for (;;) {
        if (trimCancelledRef.current) return;
        while (!trimCancelledRef.current && concurrency - parked > 1) {
          const stats = await sampleMemory();
          const avail = stats?.availableMemoryMB ?? -1;
          // avail <= 0 means the native module didn't answer — don't throttle
          // on a non-answer, that would serialise every non-iOS build.
          if (avail <= 0 || avail >= LOW_MEMORY_FLOOR_MB) break;
          parked++;
          console.warn(
            `[MEMORY] only ${avail}MB free — parking a trim worker ` +
              `(${concurrency - parked}/${concurrency} active)`
          );
          await delay(PARK_MS);
          parked--;
        }
        const clip = clipQueue.shift();
        if (!clip) return;
        // REPORTING ONLY (see the trim:* events in lib/pipelineEvents.ts).
        // Registering the clip in the shared in-flight registry is what lets
        // the batch outlive this screen safely: a re-mounted editor starts its
        // own batch, sees these ids and skips them instead of running a second
        // detect+trim on the same file.
        const flightId = parseInt(clip.id, 10);
        if (!Number.isNaN(flightId)) markTrimInFlight(flightId);
        try {
          await processOneClip(clip);
        } finally {
          if (!Number.isNaN(flightId)) clearTrimInFlight(flightId);
          completed++;
          emitPipelineEvent({
            type: 'trim:progress',
            roundId: state.roundId,
            completed,
            total,
          });
        }
      }
    };
    // Broadcast the batch so it is visible from anywhere in the app, not just
    // from the editor screen. `trim:complete` is emitted from a finally so a
    // thrown or cancelled batch can never strand the indicator.
    emitPipelineEvent({
      type: 'trim:start',
      roundId: state.roundId,
      courseName: state.courseName ?? null,
      total,
    });
    try {
      await Promise.all(Array.from({ length: concurrency }, runWorker));
    } finally {
      emitPipelineEvent({ type: 'trim:complete', roundId: state.roundId });
    }

    console.log('[useEditorState] All untrimmed clips processed');
  }, [
    state.holes,
    state.roundId,
    state.courseName,
    getTrimSettings,
    resolveDetection,
    updateClipInState,
  ]);

  /**
   * Explicit auto-trim cancellation. The batch deliberately no longer stops
   * when the editor unmounts, so the ONE caller that genuinely needs it to stop
   * has to ask by name: the mid-round "Review round so far" editor sits on top
   * of a live camera session, and trim workers would fight it for video
   * decoders and memory. The batch still emits its terminal trim:complete, so
   * the global indicator clears either way.
   */
  const cancelTrim = useCallback(() => {
    trimCancelledRef.current = true;
  }, []);

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

        // debugForceTrace / gpsOnlyTrace: ignore the classifier so street
        // tests (no club/ball → fallback-classified 'putt') still render.
        const bypassEvidence =
          config.tracer.debugForceTrace || config.tracer.gpsOnlyTrace;
        if (row.shot_type === 'putt' && !bypassEvidence) {
          await persistSkip('putt', {});
          continue;
        }
        // debugForceTrace / gpsOnlyTrace: no detected impact → anchor on the
        // clip midpoint so the arc still renders (timing approximate).
        let impactMs = row.impact_time_ms;
        if (impactMs === null && bypassEvidence) {
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

        // gpsOnlyTrace: geometry is the whole story — skip the Vision pass
        // entirely (renders on a black screen, and saves the full-res scan).
        const detection = config.tracer.gpsOnlyTrace
          ? null
          : await detectBallLaunch(detectUri, detectImpactMs);
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
    cancelTrim,
    processAllTracers,
  };
}
