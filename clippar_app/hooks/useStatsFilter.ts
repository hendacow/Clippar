import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Timeframe = '7d' | '30d' | '90d' | '1y' | 'all';

export type StatCategoryKey =
  | 'eagle'
  | 'birdie'
  | 'par'
  | 'bogey'
  | 'double'
  | 'triple';

export interface HoleScoreRow {
  round_id: string;
  hole_number: number;
  strokes: number | null;
  score_to_par: number | null;
}

export interface CategoryBreakdown {
  key: StatCategoryKey;
  count: number;
}

export interface TrendPoint {
  date: string;       // ISO date
  scoreToPar: number; // round-level
  roundId: string;
}

export interface StatsFilters {
  timeframe: Timeframe;
  courseId: string | null; // null = all courses
  hole: number | null;     // null = all holes
  clipsOnly: boolean;
}

export interface UseStatsFilterResult<R extends RoundLike = RoundLike> {
  filters: StatsFilters;
  setTimeframe: (t: Timeframe) => void;
  setCourseId: (id: string | null) => void;
  setHole: (h: number | null) => void;
  setClipsOnly: (b: boolean) => void;
  resetFilters: () => void;

  // Derived data for the UI
  filteredRounds: R[];               // rounds after applying filters (preserves input type)
  breakdown: CategoryBreakdown[];    // per-category hole counts from scores table
  trend: TrendPoint[];               // chronological round-level score to par
  availableCourses: CourseOption[];  // courses the user has played
  loadingScores: boolean;
  rawScores: HoleScoreRow[];         // all hole scores in scope (unfiltered by hole/course)
}

export interface CourseOption {
  id: string;
  name: string;
}

/**
 * Minimal shape we care about on a round. Matches mock + live data.
 * Keep it permissive so callers can pass whatever they have.
 */
export interface RoundLike {
  id: string;
  course_id?: string | null;
  course_name: string;
  date: string;
  total_score?: number | null;
  total_par?: number | null;
  score_to_par?: number | null;
  holes_played?: number | null;
  clips_count?: number | null;
  reel_url?: string | null;
  // Allow passthrough properties (best_hole etc.)
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_FILTERS: StatsFilters = {
  timeframe: 'all',
  courseId: null,
  hole: null,
  clipsOnly: false,
};

function timeframeCutoff(t: Timeframe): Date | null {
  if (t === 'all') return null;
  const now = new Date();
  const d = new Date(now);
  switch (t) {
    case '7d':
      d.setDate(d.getDate() - 7);
      break;
    case '30d':
      d.setDate(d.getDate() - 30);
      break;
    case '90d':
      d.setDate(d.getDate() - 90);
      break;
    case '1y':
      d.setFullYear(d.getFullYear() - 1);
      break;
  }
  return d;
}

export function categoryForScoreToPar(s: number): StatCategoryKey {
  if (s <= -2) return 'eagle';
  if (s === -1) return 'birdie';
  if (s === 0) return 'par';
  if (s === 1) return 'bogey';
  if (s === 2) return 'double';
  return 'triple';
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Central filter hook used by StatsHero, StatsFilterBar, and the rounds list.
 * All components read from the same object so filter changes drive every
 * downstream view at once.
 */
export function useStatsFilter<R extends RoundLike>(
  rounds: R[],
): UseStatsFilterResult<R> {
  const [filters, setFilters] = useState<StatsFilters>(DEFAULT_FILTERS);
  const [rawScores, setRawScores] = useState<HoleScoreRow[]>([]);
  const [loadingScores, setLoadingScores] = useState(false);

  // --- Load hole-level scores for the user (used for breakdown tiles) ---
  const fetchScores = useCallback(async () => {
    setLoadingScores(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setRawScores([]);
        return;
      }
      // Pull round IDs owned by user first, then scores for those rounds.
      const { data: roundRows } = await supabase
        .from('rounds')
        .select('id')
        .eq('user_id', user.id);

      const ids = (roundRows ?? []).map((r: { id: string }) => r.id);
      if (ids.length === 0) {
        setRawScores([]);
        return;
      }

      const { data: scoreRows } = await supabase
        .from('scores')
        .select('round_id, hole_number, strokes, score_to_par')
        .in('round_id', ids);

      setRawScores((scoreRows ?? []) as HoleScoreRow[]);
    } catch {
      setRawScores([]);
    } finally {
      setLoadingScores(false);
    }
  }, []);

  useEffect(() => {
    fetchScores();
  }, [fetchScores]);

  // --- Setters ---
  const setTimeframe = useCallback(
    (timeframe: Timeframe) => setFilters((f) => ({ ...f, timeframe })),
    [],
  );
  const setCourseId = useCallback(
    (courseId: string | null) => setFilters((f) => ({ ...f, courseId })),
    [],
  );
  const setHole = useCallback(
    (hole: number | null) => setFilters((f) => ({ ...f, hole })),
    [],
  );
  const setClipsOnly = useCallback(
    (clipsOnly: boolean) => setFilters((f) => ({ ...f, clipsOnly })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  // --- Derived: course options from the rounds list ---
  const availableCourses = useMemo<CourseOption[]>(() => {
    const map = new Map<string, string>();
    for (const r of rounds) {
      const id = (r.course_id as string | null | undefined) ?? r.course_name;
      if (id && !map.has(id)) map.set(id, r.course_name);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rounds]);

  // --- Derived: filtered rounds for the UI ---
  const filteredRounds = useMemo(() => {
    const cutoff = timeframeCutoff(filters.timeframe);
    return rounds.filter((r) => {
      // Timeframe
      if (cutoff && new Date(r.date) < cutoff) return false;
      // Course
      if (filters.courseId) {
        const id = (r.course_id as string | null | undefined) ?? r.course_name;
        if (id !== filters.courseId) return false;
      }
      // Clips only
      if (filters.clipsOnly && !(r.clips_count && r.clips_count > 0)) return false;
      // Hole filter is applied at the stats / drill-down level, not the rounds list,
      // because rounds span multiple holes. We still show the whole round if any of
      // its holes match.
      if (filters.hole != null) {
        const hasHole = rawScores.some(
          (s) => s.round_id === r.id && s.hole_number === filters.hole,
        );
        // If we have no scores loaded yet, fall back to including the round.
        if (rawScores.length > 0 && !hasHole) return false;
      }
      return true;
    });
  }, [rounds, filters, rawScores]);

  // --- Derived: hole-level breakdown (eagle/birdie/par/bogey/double/triple) ---
  const breakdown = useMemo<CategoryBreakdown[]>(() => {
    const cutoff = timeframeCutoff(filters.timeframe);

    // Build a set of round IDs that pass the round-level filters (course,
    // timeframe, clipsOnly). Hole filter is applied per-score below.
    const roundScopeIds = new Set(
      rounds
        .filter((r) => {
          if (cutoff && new Date(r.date) < cutoff) return false;
          if (filters.courseId) {
            const id = (r.course_id as string | null | undefined) ?? r.course_name;
            if (id !== filters.courseId) return false;
          }
          if (filters.clipsOnly && !(r.clips_count && r.clips_count > 0)) return false;
          return true;
        })
        .map((r) => r.id),
    );

    const counts: Record<StatCategoryKey, number> = {
      eagle: 0,
      birdie: 0,
      par: 0,
      bogey: 0,
      double: 0,
      triple: 0,
    };

    for (const s of rawScores) {
      if (s.score_to_par == null) continue;
      if (!roundScopeIds.has(s.round_id)) continue;
      if (filters.hole != null && s.hole_number !== filters.hole) continue;
      counts[categoryForScoreToPar(s.score_to_par)]++;
    }

    return (
      ['eagle', 'birdie', 'par', 'bogey', 'double', 'triple'] as StatCategoryKey[]
    ).map((key) => ({ key, count: counts[key] }));
  }, [rawScores, rounds, filters]);

  // --- Derived: trend series ---
  const trend = useMemo<TrendPoint[]>(() => {
    return filteredRounds
      .filter((r) => r.score_to_par != null)
      .slice()
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((r) => ({
        date: r.date,
        scoreToPar: r.score_to_par as number,
        roundId: r.id,
      }));
  }, [filteredRounds]);

  return {
    filters,
    setTimeframe,
    setCourseId,
    setHole,
    setClipsOnly,
    resetFilters,
    filteredRounds,
    breakdown,
    trend,
    availableCourses,
    loadingScores,
    rawScores,
  };
}
