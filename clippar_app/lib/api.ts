import { supabase } from './supabase';
import type { Round } from '@/types/round';
import {
  type CoursePreset,
  type CoursePresetInput,
  defaultPresetName,
} from '@/types/preset';

// Resolve the signed-in user from the locally-stored session.
//
// `supabase.auth.getUser()` validates the access token against the Auth
// server on every call. A flaky connection — or an access token a moment
// past expiry that hasn't auto-refreshed yet — makes it return no user,
// surfacing as a misleading "Not authenticated" error even though a valid,
// refreshable session is sitting in local storage. `getSession()` reads
// (and silently refreshes) that stored session without a network round
// trip. RLS still enforces auth server-side on every query below, so
// trusting the local session for the user id is safe.
async function getSessionUser() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user ?? null;
}

async function requireUser() {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  return user;
}

// ============ Profiles ============

export async function getProfile() {
  const user = await requireUser();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // If profile row is missing (e.g. the on_auth_user_created trigger failed),
  // create it now so the app can continue normally.
  if (error && error.code === 'PGRST116') {
    const displayName =
      user.user_metadata?.full_name || user.email?.split('@')[0] || '';
    const { data: created, error: insertErr } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email,
        display_name: displayName,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;
    return created;
  }

  if (error) throw error;
  return data;
}

export async function updateProfile(updates: Record<string, unknown>) {
  const user = await requireUser();

  const { data, error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ============ Rounds ============

export async function getRounds() {
  const user = await requireUser();

  // Sort by created_at (TIMESTAMPTZ) so multiple rounds on the same date
  // are ordered correctly. Falling back to `date` (DATE column, no time)
  // groups same-day rounds together with no defined order.
  const { data, error } = await supabase
    .from('rounds')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function getRound(id: string) {
  // Try with scores join first; fall back to shots-only if scores table doesn't exist
  const { data, error } = await supabase
    .from('rounds')
    .select('*, shots(*)')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

export async function createRound(round: {
  course_id?: string;
  course_name: string;
  holes_played?: number;
}) {
  const user = await requireUser();

  const { data, error } = await supabase
    .from('rounds')
    .insert({
      user_id: user.id,
      course_name: round.course_name,
      course_id: round.course_id,
      holes_played: round.holes_played ?? 18,
      status: 'recording',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateRound(id: string, updates: Partial<Round>) {
  const { data, error } = await supabase
    .from('rounds')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteRound(id: string) {
  // 1. Delete clips from storage (list then remove)
  try {
    const { data: clipFiles } = await supabase.storage
      .from('clips')
      .list(id);
    if (clipFiles && clipFiles.length > 0) {
      const clipPaths = clipFiles.map((f) => `${id}/${f.name}`);
      await supabase.storage.from('clips').remove(clipPaths);
    }
  } catch (err) {
    console.log('[API] deleteRound: failed to delete clips from storage', err);
  }

  // 2. Delete reel from storage
  try {
    const { data: reelFiles } = await supabase.storage
      .from('reels')
      .list(id);
    if (reelFiles && reelFiles.length > 0) {
      const reelPaths = reelFiles.map((f) => `${id}/${f.name}`);
      await supabase.storage.from('reels').remove(reelPaths);
    }
  } catch (err) {
    console.log('[API] deleteRound: failed to delete reels from storage', err);
  }

  // 3. Delete related database rows (scores, shots, processing_jobs)
  await supabase.from('scores').delete().eq('round_id', id);
  await supabase.from('shots').delete().eq('round_id', id);
  await supabase.from('processing_jobs').delete().eq('round_id', id);

  // 4. Delete the round itself
  const { error } = await supabase.from('rounds').delete().eq('id', id);
  if (error) throw error;
}

// ============ Scores ============

export async function getScores(roundId: string) {
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('round_id', roundId)
      .order('hole_number');

    if (error) {
      console.log('[API] getScores skipped:', error.message);
      return [];
    }
    return data ?? [];
  } catch {
    return [];
  }
}

export async function upsertScore(score: {
  round_id: string;
  hole_number: number;
  strokes: number;
  par?: number;
  putts?: number;
  penalty_strokes?: number;
  is_pickup?: boolean;
  score_to_par?: number;
}) {
  try {
    // Auto-compute score_to_par when par is provided but score_to_par isn't
    const finalScore = { ...score };
    if (finalScore.par != null && finalScore.score_to_par == null) {
      finalScore.score_to_par = finalScore.strokes - finalScore.par;
    }

    const { data, error } = await supabase
      .from('scores')
      .upsert(finalScore, { onConflict: 'round_id,hole_number' })
      .select()
      .single();

    if (error) {
      // Table may not exist yet — non-critical, scores are also saved locally
      console.log('[API] upsertScore skipped:', error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Repair existing scores that are missing par/score_to_par.
 * Joins scores -> rounds -> courses -> holes to backfill par data,
 * then computes score_to_par = strokes - par.
 * Call once on app startup (idempotent, only updates NULLs).
 */
export async function repairScoresParData(): Promise<number> {
  try {
    const user = await getSessionUser();
    if (!user) return 0;

    // Find scores with NULL score_to_par for this user's rounds
    const { data: broken, error } = await supabase
      .from('scores')
      .select('id, round_id, hole_number, strokes, par, score_to_par, rounds!inner(user_id, course_id)')
      .eq('rounds.user_id', user.id)
      .is('score_to_par', null);

    if (error || !broken || broken.length === 0) return 0;

    let repaired = 0;

    for (const score of broken) {
      let par = score.par;

      // If par is also NULL, try to get it from the holes table
      if (par == null) {
        const courseId = (score.rounds as any)?.course_id;
        if (courseId) {
          const { data: hole } = await supabase
            .from('holes')
            .select('par')
            .eq('course_id', courseId)
            .eq('hole_number', score.hole_number)
            .maybeSingle();
          if (hole?.par) par = hole.par;
        }
      }

      // Still no par? Default to 4
      if (par == null) par = 4;

      const score_to_par = score.strokes - par;

      const { error: updateError } = await supabase
        .from('scores')
        .update({ par, score_to_par })
        .eq('id', score.id);

      if (!updateError) repaired++;
    }

    if (repaired > 0) {
      console.log(`[API] repairScoresParData: fixed ${repaired} scores`);
    }
    return repaired;
  } catch (err) {
    console.log('[API] repairScoresParData error:', err);
    return 0;
  }
}

export async function saveScoreToSupabase(score: {
  round_id: string;
  hole_number: number;
  strokes: number;
  par: number;
  putts?: number;
  penalty_strokes?: number;
}) {
  const user = await getSessionUser();
  if (!user) return;

  const score_to_par = score.strokes - score.par;

  const { error } = await supabase
    .from('scores')
    .upsert({
      round_id: score.round_id,
      hole_number: score.hole_number,
      strokes: score.strokes,
      par: score.par,
      score_to_par,
      putts: score.putts ?? 0,
      penalty_strokes: score.penalty_strokes ?? 0,
    }, { onConflict: 'round_id,hole_number' });

  if (error) {
    console.log('[API] saveScoreToSupabase error:', error);
  }
}

// ============ Shots ============

export async function createShot(shot: {
  round_id: string;
  user_id: string;
  hole_number: number;
  shot_number: number;
  clip_url?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  detection_method?: string;
  is_penalty?: boolean;
}) {
  const { data, error } = await supabase
    .from('shots')
    .insert(shot)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ============ Processing Jobs ============

export async function getProcessingJob(roundId: string) {
  try {
    const { data, error } = await supabase
      .from('processing_jobs')
      .select('*')
      .eq('round_id', roundId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') {
        console.log('[API] getProcessingJob skipped:', error.message);
      }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ============ Courses ============

export async function searchCourses(query: string, enableFallback = false) {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .ilike('name', `%${query}%`)
      .order('name')
      .limit(10);

    if (error) {
      console.log('[API] searchCourses skipped:', error.message);
      return [];
    }

    const results = data ?? [];

    // If local results are sparse and fallback enabled, try external API
    if (results.length < 2 && enableFallback && query.trim().length >= 3) {
      const apiResults = await syncCourseFromAPI(query);
      if (apiResults.length > 0) {
        // Merge, deduplicate by id
        const ids = new Set(results.map(r => r.id));
        for (const r of apiResults) {
          if (!ids.has(r.id)) {
            results.push(r);
            ids.add(r.id);
          }
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Falls back to external golf API (via edge function) when local search is empty.
 * Calls the sync-courses edge function which searches GolfCourseAPI.com,
 * upserts the course + holes into Supabase, then we re-query locally.
 */
export async function syncCourseFromAPI(courseName: string): Promise<any[]> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-courses', {
      body: { action: 'sync_single', name: courseName },
    });

    if (error || !data?.success) {
      console.log('[API] syncCourseFromAPI: no result from edge function');
      return [];
    }

    // Re-query local table now that the course was upserted
    if (data.course_id) {
      const { data: course } = await supabase
        .from('courses')
        .select('*')
        .eq('id', data.course_id);
      return course ?? [];
    }

    // If no specific course_id, re-search locally
    return await searchCourses(courseName);
  } catch (err) {
    console.log('[API] syncCourseFromAPI error:', err);
    return [];
  }
}

/**
 * Bulk-sync courses for a region via the edge function.
 * Useful for pre-populating courses in a given area.
 */
export async function syncRegionCourses(
  searchTerms: string[],
  country = 'AU',
  state = 'QLD'
) {
  try {
    const { data, error } = await supabase.functions.invoke('sync-courses', {
      body: { action: 'sync_region', country, state, search_terms: searchTerms },
    });
    if (error) {
      console.log('[API] syncRegionCourses error:', error);
      return null;
    }
    return data;
  } catch (err) {
    console.log('[API] syncRegionCourses error:', err);
    return null;
  }
}

/**
 * Search courses near a lat/lng coordinate.
 * Uses a bounding-box approximation (no PostGIS dependency in the query).
 * radiusKm defaults to 50.
 */
export async function searchCoursesNearby(
  latitude: number,
  longitude: number,
  radiusKm = 50,
  limit = 20
) {
  try {
    // Rough bounding box: 1 degree lat ~ 111 km
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));

    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .gte('latitude', latitude - latDelta)
      .lte('latitude', latitude + latDelta)
      .gte('longitude', longitude - lngDelta)
      .lte('longitude', longitude + lngDelta)
      .order('name')
      .limit(limit);

    if (error) {
      console.log('[API] searchCoursesNearby skipped:', error.message);
      return [];
    }
    return data ?? [];
  } catch {
    return [];
  }
}

export async function getCourse(courseId: string) {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .single();

    if (error) {
      console.log('[API] getCourse skipped:', error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function getCourseHoles(courseId: string) {
  try {
    const { data, error } = await supabase
      .from('holes')
      .select('*')
      .eq('course_id', courseId)
      .order('hole_number');

    if (error) {
      console.log('[API] getCourseHoles skipped:', error.message);
      return [];
    }
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Get a course with its holes in a single call.
 */
export async function getCourseWithHoles(courseId: string) {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('*, holes(*)')
      .eq('id', courseId)
      .single();

    if (error) {
      console.log('[API] getCourseWithHoles skipped:', error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ============ Course Suggestions (community data) ============

export async function submitCourseSuggestion(suggestion: {
  course_name: string;
  location_name?: string;
  state?: string;
  country?: string;
  holes_count?: number;
  par_total?: number;
  hole_data?: { holeNumber: number; par: number; strokeIndex?: number; lengthMeters?: number }[];
}) {
  try {
    const user = await requireUser();

    const { data, error } = await supabase
      .from('course_suggestions')
      .insert({
        user_id: user.id,
        course_name: suggestion.course_name,
        location_name: suggestion.location_name ?? null,
        state: suggestion.state ?? 'QLD',
        country: suggestion.country ?? 'AU',
        holes_count: suggestion.holes_count ?? 18,
        par_total: suggestion.par_total ?? null,
        hole_data: suggestion.hole_data ?? null,
      })
      .select()
      .single();

    if (error) {
      console.log('[API] submitCourseSuggestion error:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.log('[API] submitCourseSuggestion error:', err);
    return null;
  }
}

export async function getMyCourseSuggestions() {
  try {
    const user = await getSessionUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('course_suggestions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.log('[API] getMyCourseSuggestions skipped:', error.message);
      return [];
    }
    return data ?? [];
  } catch {
    return [];
  }
}

// ============ Hardware Orders ============

export async function getHardwareOrder() {
  try {
    const user = await getSessionUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from('hardware_orders')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.log('[API] getHardwareOrder skipped:', error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function getHardwareOrders() {
  try {
    const user = await getSessionUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('hardware_orders')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.log('[API] getHardwareOrders skipped:', error.message);
      return [];
    }
    return data ?? [];
  } catch {
    return [];
  }
}

// ============ User Stats ============

export async function getUserStats() {
  const zero = {
    roundsPlayed: 0,
    bestScore: 0,
    avgScore: 0,
    totalBirdies: 0,
    totalEagles: 0,
    totalClips: 0,
    avgPutts: 0,
    coursesPlayed: 0,
  };

  try {
    const user = await getSessionUser();
    if (!user) return zero;

    // Fetch all rounds for the user
    const { data: rounds, error: roundsError } = await supabase
      .from('rounds')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });

    if (roundsError || !rounds || rounds.length === 0) return zero;

    const roundsPlayed = rounds.length;

    // Best score (lowest total_score among completed rounds)
    const completedScores = rounds
      .filter((r: any) => r.total_score != null)
      .map((r: any) => r.total_score as number);
    const bestScore = completedScores.length > 0 ? Math.min(...completedScores) : 0;

    // Average score
    const avgScore =
      completedScores.length > 0
        ? Math.round((completedScores.reduce((a: number, b: number) => a + b, 0) / completedScores.length) * 10) / 10
        : 0;

    // Average putts
    const puttsValues = rounds
      .filter((r: any) => r.total_putts != null)
      .map((r: any) => r.total_putts as number);
    const avgPutts =
      puttsValues.length > 0
        ? Math.round((puttsValues.reduce((a: number, b: number) => a + b, 0) / puttsValues.length) * 10) / 10
        : 0;

    // Unique courses played
    const uniqueCourses = new Set(rounds.map((r: any) => r.course_name));
    const coursesPlayed = uniqueCourses.size;

    // Total clips from shots table
    const roundIds = rounds.map((r: any) => r.id);
    const { count: totalClips } = await supabase
      .from('shots')
      .select('*', { count: 'exact', head: true })
      .in('round_id', roundIds);

    // Fetch per-hole scores for birdies and eagles
    let totalBirdies = 0;
    let totalEagles = 0;

    const { data: scores, error: scoresError } = await supabase
      .from('scores')
      .select('score_to_par')
      .in('round_id', roundIds);

    if (!scoresError && scores) {
      for (const s of scores) {
        if (s.score_to_par === -1) totalBirdies++;
        else if (s.score_to_par != null && s.score_to_par <= -2) totalEagles++;
      }
    }

    return {
      roundsPlayed,
      bestScore,
      avgScore,
      totalBirdies,
      totalEagles,
      totalClips: totalClips ?? 0,
      avgPutts,
      coursesPlayed,
    };
  } catch (err) {
    console.log('[API] getUserStats error:', err);
    return zero;
  }
}

// ============ Score Highlights ============

export type ScoreCategory = 'eagle' | 'birdie' | 'par' | 'bogey' | 'double_bogey';

export interface ScoreHighlightHole {
  roundId: string;
  courseName: string;
  date: string;
  holeNumber: number;
  strokes: number;
  scoreToPar: number;
  shots: {
    id: string;
    shotNumber: number;
    clipUrl: string | null;
  }[];
}

export interface ScoreHighlightGroup {
  roundId: string;
  courseName: string;
  date: string;
  holes: Omit<ScoreHighlightHole, 'roundId' | 'courseName' | 'date'>[];
}

const CATEGORY_FILTER: Record<ScoreCategory, (scoreToPar: number) => boolean> = {
  eagle: (s) => s <= -2,
  birdie: (s) => s === -1,
  par: (s) => s === 0,
  bogey: (s) => s === 1,
  double_bogey: (s) => s >= 2,
};

/**
 * Fetch all holes matching a score category across all rounds,
 * along with their shot clips. Results are grouped by round, ordered by date desc.
 */
export async function getScoreHighlights(
  category: ScoreCategory,
  dateFilter?: 'month' | '3months' | 'all',
): Promise<ScoreHighlightGroup[]> {
  const user = await requireUser();

  // 1. Fetch all rounds
  let roundsQuery = supabase
    .from('rounds')
    .select('id, course_name, date')
    .eq('user_id', user.id)
    .order('date', { ascending: false });

  if (dateFilter === 'month') {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    roundsQuery = roundsQuery.gte('date', d.toISOString().split('T')[0]);
  } else if (dateFilter === '3months') {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    roundsQuery = roundsQuery.gte('date', d.toISOString().split('T')[0]);
  }

  const { data: rounds, error: roundsError } = await roundsQuery;
  if (roundsError || !rounds || rounds.length === 0) return [];

  const roundIds = rounds.map((r) => r.id);
  const filterFn = CATEGORY_FILTER[category];

  // 2. Fetch all scores for these rounds that match the category
  const { data: scores, error: scoresError } = await supabase
    .from('scores')
    .select('round_id, hole_number, strokes, score_to_par')
    .in('round_id', roundIds)
    .not('score_to_par', 'is', null);

  if (scoresError || !scores) return [];

  // Filter by category
  const matchingScores = scores.filter(
    (s) => s.score_to_par != null && filterFn(s.score_to_par),
  );

  if (matchingScores.length === 0) return [];

  // 3. Fetch shots for matching round+hole combos
  // Build a map of round_id -> hole_numbers
  const roundHoleMap = new Map<string, Set<number>>();
  for (const s of matchingScores) {
    if (!roundHoleMap.has(s.round_id)) roundHoleMap.set(s.round_id, new Set());
    roundHoleMap.get(s.round_id)!.add(s.hole_number);
  }

  const matchingRoundIds = Array.from(roundHoleMap.keys());
  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('id, round_id, hole_number, shot_number, clip_url')
    .in('round_id', matchingRoundIds)
    .order('shot_number');

  // Filter shots to only include matching holes
  const matchingShots = (shots ?? []).filter((sh) => {
    const holes = roundHoleMap.get(sh.round_id);
    return holes && holes.has(sh.hole_number);
  });

  // 4. Group into result structure
  const roundMap = new Map(rounds.map((r) => [r.id, r]));
  const groups = new Map<string, ScoreHighlightGroup>();

  for (const score of matchingScores) {
    const round = roundMap.get(score.round_id);
    if (!round) continue;

    if (!groups.has(score.round_id)) {
      groups.set(score.round_id, {
        roundId: score.round_id,
        courseName: round.course_name,
        date: round.date,
        holes: [],
      });
    }

    const holeShots = matchingShots
      .filter((sh) => sh.round_id === score.round_id && sh.hole_number === score.hole_number)
      .map((sh) => ({
        id: sh.id,
        shotNumber: sh.shot_number,
        clipUrl: sh.clip_url,
      }));

    groups.get(score.round_id)!.holes.push({
      holeNumber: score.hole_number,
      strokes: score.strokes,
      scoreToPar: score.score_to_par!,
      shots: holeShots,
    });
  }

  // Sort holes within each group
  for (const group of groups.values()) {
    group.holes.sort((a, b) => a.holeNumber - b.holeNumber);
  }

  // Return in date desc order (matching round order)
  return rounds
    .filter((r) => groups.has(r.id))
    .map((r) => groups.get(r.id)!);
}

/**
 * Get best rounds sorted by lowest score_to_par.
 */
export async function getBestRounds(limit = 20) {
  const user = await requireUser();

  const { data, error } = await supabase
    .from('rounds')
    .select('*')
    .eq('user_id', user.id)
    .not('score_to_par', 'is', null)
    .order('score_to_par', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * Generate signed URLs for clip paths in the clips bucket.
 * Returns a map of clip_url -> signed_url.
 */
export async function getSignedClipUrls(
  clipPaths: string[],
  expiresIn = 3600,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (clipPaths.length === 0) return result;

  // Batch sign in parallel (Supabase doesn't have batch sign, so we do them individually)
  const promises = clipPaths.map(async (path) => {
    try {
      // clip_url is stored as "clips/{roundId}/{filename}" but the bucket is already "clips",
      // so we must strip the "clips/" prefix to avoid double-prefixing the path.
      const pathInBucket = path.startsWith('clips/') ? path.slice(6) : path;

      const { data, error } = await supabase.storage
        .from('clips')
        .createSignedUrl(pathInBucket, expiresIn);
      if (!error && data?.signedUrl) {
        // Key by the ORIGINAL path so lookups from shot.clipUrl still match
        result[path] = data.signedUrl;
      }
    } catch {
      // Skip failed URLs silently
    }
  });

  await Promise.all(promises);
  return result;
}

// ============ Highlight Compilation ============

export type HighlightCompilationCategory =
  | 'eagle'
  | 'birdie'
  | 'par'
  | 'bogey'
  | 'double'
  | 'triple';

export type HighlightCompilationTimeframe = '7d' | '30d' | '90d' | '1y' | 'all';

const COMPILATION_FILTER: Record<
  HighlightCompilationCategory,
  (scoreToPar: number) => boolean
> = {
  eagle: (s) => s <= -2,
  birdie: (s) => s === -1,
  par: (s) => s === 0,
  bogey: (s) => s === 1,
  double: (s) => s === 2,
  triple: (s) => s >= 3,
};

function compilationTimeframeCutoff(t: HighlightCompilationTimeframe): Date | null {
  const d = new Date();
  switch (t) {
    case '7d': d.setDate(d.getDate() - 7); return d;
    case '30d': d.setDate(d.getDate() - 30); return d;
    case '90d': d.setDate(d.getDate() - 90); return d;
    case '1y': d.setFullYear(d.getFullYear() - 1); return d;
    case 'all': return null;
  }
}

/**
 * Fetch clip URLs for a highlight compilation filtered by category
 * (birdies, bogeys, etc.) and optional course/hole/timeframe. Returns the
 * paths (shots.clip_url) in chronological-desc order along with pre-signed
 * URLs ready to hand to `stitchClips`.
 *
 * Ordering: most recent round first, then by hole number, then shot_number.
 */
export async function getHighlightCompilationClips(
  category: HighlightCompilationCategory,
  opts: {
    courseId?: string | null;
    hole?: number | null;
    timeframe?: HighlightCompilationTimeframe;
  } = {},
): Promise<{ clipPaths: string[]; signedUrls: string[] }> {
  const user = await requireUser();

  // 1. Rounds scoped to user + optional course + timeframe
  let roundsQuery = supabase
    .from('rounds')
    .select('id, date, course_id')
    .eq('user_id', user.id)
    .order('date', { ascending: false });

  if (opts.courseId) {
    roundsQuery = roundsQuery.eq('course_id', opts.courseId);
  }
  const cutoff = compilationTimeframeCutoff(opts.timeframe ?? 'all');
  if (cutoff) {
    roundsQuery = roundsQuery.gte('date', cutoff.toISOString().split('T')[0]);
  }

  const { data: rounds, error: roundsError } = await roundsQuery;
  if (roundsError || !rounds || rounds.length === 0) {
    return { clipPaths: [], signedUrls: [] };
  }

  const roundIds = rounds.map((r) => r.id);
  const roundDate = new Map(rounds.map((r) => [r.id, r.date as string]));
  const filterFn = COMPILATION_FILTER[category];

  // 2. Scores matching category (+ optional hole filter)
  let scoresQuery = supabase
    .from('scores')
    .select('round_id, hole_number, score_to_par')
    .in('round_id', roundIds)
    .not('score_to_par', 'is', null);
  if (opts.hole != null) {
    scoresQuery = scoresQuery.eq('hole_number', opts.hole);
  }

  const { data: scores, error: scoresError } = await scoresQuery;
  if (scoresError || !scores) return { clipPaths: [], signedUrls: [] };

  const matching = scores.filter(
    (s) => s.score_to_par != null && filterFn(s.score_to_par),
  );
  if (matching.length === 0) return { clipPaths: [], signedUrls: [] };

  // 3. Look up shots for matching (round_id, hole_number) pairs
  const pairs = new Set(matching.map((s) => `${s.round_id}:${s.hole_number}`));
  const targetRoundIds = Array.from(new Set(matching.map((s) => s.round_id)));

  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('round_id, hole_number, shot_number, clip_url')
    .in('round_id', targetRoundIds)
    .not('clip_url', 'is', null);
  if (shotsError || !shots) return { clipPaths: [], signedUrls: [] };

  const validShots = shots
    .filter((s) => s.clip_url && pairs.has(`${s.round_id}:${s.hole_number}`))
    .sort((a, b) => {
      const da = roundDate.get(a.round_id) ?? '';
      const db = roundDate.get(b.round_id) ?? '';
      if (da !== db) return db.localeCompare(da); // newest first
      if (a.hole_number !== b.hole_number) return a.hole_number - b.hole_number;
      return a.shot_number - b.shot_number;
    });

  const clipPaths = validShots
    .map((s) => s.clip_url as string | null)
    .filter((p): p is string => !!p);

  if (clipPaths.length === 0) return { clipPaths: [], signedUrls: [] };

  // 4. Sign URLs (reuses existing helper)
  const signedMap = await getSignedClipUrls(clipPaths);
  const signedUrls = clipPaths
    .map((p) => signedMap[p])
    .filter((u): u is string => !!u);

  return { clipPaths, signedUrls };
}

/**
 * Generate a signed URL for a reel in the reels bucket.
 */
export async function getSignedReelUrl(
  reelPath: string,
  expiresIn = 3600,
): Promise<string | null> {
  if (!reelPath) return null;
  // Reels saved locally (cloud backup off) keep a file:// URI in rounds.reel_url.
  // Pass them straight through — there's no signed URL to mint, the player can
  // play the local file directly. Without this, the homescreen reel preview
  // shows nothing for any round composed without cloud backup.
  if (reelPath.startsWith('file://') || reelPath.startsWith('/')) {
    return reelPath;
  }
  try {
    const { data, error } = await supabase.storage
      .from('reels')
      .createSignedUrl(reelPath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * For rounds that don't have a reel yet, fetch the first clip from
 * Supabase Storage at clips/{roundId}/ and return a signed URL.
 * Returns null if no clips exist or signing fails.
 */
export async function getFirstClipSignedUrl(
  roundId: string,
  expiresIn = 3600,
): Promise<string | null> {
  try {
    const { data: files, error: listError } = await supabase.storage
      .from('clips')
      .list(roundId, { limit: 1, sortBy: { column: 'name', order: 'asc' } });

    if (listError || !files || files.length === 0) return null;

    const filePath = `${roundId}/${files[0].name}`;
    const { data, error } = await supabase.storage
      .from('clips')
      .createSignedUrl(filePath, expiresIn);

    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

// ============ Course Upsert from Live API ============

/**
 * Upsert a course from the live Golf Course API into Supabase for caching.
 * Takes a GolfCourseSearchResult-shaped object and optional hole data,
 * then inserts or updates the local courses + holes tables.
 * Returns the Supabase course row (with its UUID id).
 */
export async function upsertCourseFromLiveApi(
  course: {
    id: string;
    name: string;
    city?: string;
    state?: string;
    country: string;
    holes?: number;
    latitude?: number;
    longitude?: number;
  },
  holesData?: { number: number; par: number; handicap?: number; metres?: number }[],
): Promise<any | null> {
  try {
    // Check if course already exists by source + source_id
    const { data: existing } = await supabase
      .from('courses')
      .select('*')
      .eq('source', 'golfcourseapi')
      .eq('source_id', course.id)
      .maybeSingle();

    let courseRow = existing;

    if (!courseRow) {
      // Also check by name + country
      const { data: byName } = await supabase
        .from('courses')
        .select('*')
        .ilike('name', course.name)
        .eq('country', course.country || 'AU')
        .maybeSingle();

      courseRow = byName;
    }

    const parTotal = holesData?.reduce((sum, h) => sum + h.par, 0) ?? null;

    if (courseRow) {
      // Update existing row
      const { data: updated } = await supabase
        .from('courses')
        .update({
          location_name: course.city || courseRow.location_name,
          state: course.state || courseRow.state,
          latitude: course.latitude ?? courseRow.latitude,
          longitude: course.longitude ?? courseRow.longitude,
          holes_count: course.holes || courseRow.holes_count,
          par_total: parTotal || courseRow.par_total,
          source: 'golfcourseapi',
          source_id: course.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', courseRow.id)
        .select('*')
        .single();
      courseRow = updated || courseRow;
    } else {
      // Insert new course
      const { data: inserted, error } = await supabase
        .from('courses')
        .insert({
          name: course.name,
          location_name: course.city || null,
          state: course.state || null,
          country: course.country || 'AU',
          latitude: course.latitude || null,
          longitude: course.longitude || null,
          holes_count: course.holes || 18,
          par_total: parTotal,
          source: 'golfcourseapi',
          source_id: course.id,
        })
        .select('*')
        .single();

      if (error) {
        console.log('[API] upsertCourseFromLiveApi insert error:', error.message);
        return null;
      }
      courseRow = inserted;
    }

    // Upsert holes if provided
    if (holesData && holesData.length > 0 && courseRow?.id) {
      for (const hole of holesData) {
        await supabase
          .from('holes')
          .upsert(
            {
              course_id: courseRow.id,
              hole_number: hole.number,
              par: hole.par,
              stroke_index: hole.handicap ?? null,
              length_meters: hole.metres ?? null,
            },
            { onConflict: 'course_id,hole_number' }
          );
      }
    }

    return courseRow;
  } catch (err) {
    console.log('[API] upsertCourseFromLiveApi error:', err);
    return null;
  }
}

// ============ Music Tracks ============

export async function getMusicTracks() {
  const { data, error } = await supabase
    .from('music_tracks')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');

  if (error) throw error;
  return data;
}

// ============ Course Presets (Wave 3) ============

/**
 * Returns the user's presets, most-recently-used first. Empty array when
 * the user has none yet — never throws on no rows.
 */
export async function listCoursePresets(): Promise<CoursePreset[]> {
  const user = await requireUser();

  const { data, error } = await supabase
    .from('course_presets')
    .select('*')
    .eq('user_id', user.id)
    .order('last_used_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as CoursePreset[];
}

/**
 * Insert a new preset. `name` defaults to `<course> — <holes> holes` when
 * the caller doesn't supply one. The unique-per-user-name constraint will
 * reject duplicates — callers should catch and ask the user to rename.
 */
export async function createCoursePreset(
  input: CoursePresetInput
): Promise<CoursePreset> {
  const user = await requireUser();

  const name = input.name?.trim() || defaultPresetName({
    course_name: input.course_name,
    holes_played: input.holes_played,
  });

  const { data, error } = await supabase
    .from('course_presets')
    .insert({
      user_id: user.id,
      course_id: input.course_id,
      course_name: input.course_name,
      holes_played: input.holes_played,
      start_hole: input.start_hole,
      trim_duration_ms: input.trim_duration_ms ?? null,
      hole_pars: input.hole_pars ?? null,
      name,
    })
    .select()
    .single();

  if (error) throw error;
  return data as CoursePreset;
}

/**
 * Save a preset, UPDATING in place when the user already has one with the
 * same name (the UNIQUE(user_id, name) key) instead of throwing on the
 * duplicate. This lets the user iterate on a saved scorecard — re-saving a
 * corrected par for the same course overwrites the old row (updated_at is
 * bumped by the 009 trigger; we also bump last_used_at so the fixed
 * scorecard sorts to the top and is what loads next time). Falls back to a
 * plain insert when no same-named preset exists.
 *
 * DB-authoritative: the existing row is looked up by (user_id, name) rather
 * than trusting an in-memory list, so a preset saved on another device is
 * still updated (not duplicated / rejected). RLS's owner UPDATE policy plus
 * the explicit user_id filter scope both the lookup and the write to the
 * caller's own rows.
 */
export async function upsertCoursePreset(
  input: CoursePresetInput
): Promise<CoursePreset> {
  const user = await requireUser();

  const name = input.name?.trim() || defaultPresetName({
    course_name: input.course_name,
    holes_played: input.holes_played,
  });

  const { data: existing, error: findError } = await supabase
    .from('course_presets')
    .select('id')
    .eq('user_id', user.id)
    .eq('name', name)
    .maybeSingle();

  if (findError) throw findError;

  // No same-named preset yet → this is a fresh save.
  if (!existing) {
    return createCoursePreset({ ...input, name });
  }

  // Same-named preset exists → overwrite its scorecard + setup fields.
  const { data, error } = await supabase
    .from('course_presets')
    .update({
      course_id: input.course_id,
      course_name: input.course_name,
      holes_played: input.holes_played,
      start_hole: input.start_hole,
      trim_duration_ms: input.trim_duration_ms ?? null,
      hole_pars: input.hole_pars ?? null,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data as CoursePreset;
}

/**
 * Mark a preset as just-used so it sorts to the top of the picker next
 * time. Called when the user starts a round from a preset. Best-effort —
 * we don't propagate errors here because failing to bump the timestamp
 * shouldn't block the round from starting.
 *
 * Defence-in-depth: matches the auth check + explicit user_id filter the
 * other helpers use. RLS is the actual guard, but if the supabase client
 * is ever initialised with a service-role key (CI/admin path), the
 * explicit filter still scopes the update to the caller's rows.
 */
export async function touchCoursePreset(id: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  // Supabase returns errors in-band via `{ error }`; they don't throw. Read
  // and log so we don't silently mask RLS rejections / 401s. Still
  // non-fatal — a failed touch shouldn't break the user's flow.
  const { error } = await supabase
    .from('course_presets')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.log('[touchCoursePreset] non-fatal:', error.message);
  }
}

/**
 * Permanently remove a preset. Doesn't touch any rounds that referenced
 * it — presets are advisory, not relational from the round's side.
 *
 * Defence-in-depth: auth check + explicit user_id filter for the same
 * reason as touchCoursePreset above.
 */
export async function deleteCoursePreset(id: string): Promise<void> {
  const user = await requireUser();

  const { error } = await supabase
    .from('course_presets')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) throw error;
}

// ─── Account deletion (App Review 5.1.1(v)) ───

/**
 * Permanently delete the signed-in user's account via the delete-account
 * edge function (storage + non-cascading rows + auth user). The caller is
 * responsible for signing out locally afterwards.
 */
export async function deleteAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account', {
    method: 'POST',
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error ?? 'Account deletion failed');
}

/**
 * Capture the Apple refresh token at Sign-in-with-Apple time so the account can
 * be revoked with Apple on deletion (App Store 5.1.1(v)). Hands the one-time
 * authorization code + identity token to the apple-link edge function, which
 * exchanges and stores the refresh token server-side.
 *
 * Best-effort and intentionally swallowing: this must never break sign-in. If
 * it fails we simply won't have a token to revoke later (revocation is itself
 * best-effort). Returns true only when the server confirms a link was stored.
 */
export async function linkAppleCredentials(
  authorizationCode: string,
  identityToken: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke('apple-link', {
      method: 'POST',
      body: { authorizationCode, identityToken },
    });
    if (error) {
      console.warn('[apple-link] failed:', error.message ?? error);
      return false;
    }
    return data?.linked === true;
  } catch (err) {
    console.warn('[apple-link] error:', err);
    return false;
  }
}
