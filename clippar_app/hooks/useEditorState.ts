import { useState, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getClipUrl } from '@/lib/r2';
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

      // Generate signed URLs for all clips
      const clips = await Promise.all(
        shots.map(async (shot): Promise<EditorClip> => {
          let sourceUri: string | null = null;
          if (shot.clip_url) {
            sourceUri = await getClipUrl(shot.clip_url);
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

      const clips: EditorClip[] = localClips.map((c) => ({
        id: String(c.id),
        type: 'shot' as const,
        holeNumber: c.hole_number,
        shotNumber: c.shot_number,
        sourceUri: c.file_uri, // local file URI on device
        storagePath: c.uploaded
          ? `${roundId}/hole${c.hole_number}_shot${c.shot_number}_${c.id}.mp4`
          : null,
        trimStartMs: c.trim_start_ms ?? 0,
        trimEndMs: c.trim_end_ms ?? -1,
        durationMs: (c.duration_seconds ?? 0) * 1000,
        isExcluded: (c.is_excluded ?? 0) === 1,
      }));

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
    (clipId: string, trimStartMs: number, trimEndMs: number) => {
      setState((prev) => ({
        ...prev,
        holes: prev.holes.map((h) => ({
          ...h,
          clips: h.clips.map((c) =>
            c.id === clipId ? { ...c, trimStartMs, trimEndMs } : c
          ),
        })),
      }));
      // Persist to SQLite
      const numId = parseInt(clipId, 10);
      if (!isNaN(numId) && storage) {
        storage.updateClipEditorState(numId, {
          trim_start_ms: trimStartMs,
          trim_end_ms: trimEndMs,
        }).catch(() => {});
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
  };
}
