import { supabase } from './supabase';
import type { Round } from '@/types/round';

// ============ Profiles ============

export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('rounds')
    .select('*')
    .eq('user_id', user.id)
    .order('date', { ascending: false });

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
  putts?: number;
  penalty_strokes?: number;
  is_pickup?: boolean;
  score_to_par?: number;
}) {
  try {
    const { data, error } = await supabase
      .from('scores')
      .upsert(score, { onConflict: 'round_id,hole_number' })
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

export async function searchCourses(query: string) {
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
    return data ?? [];
  } catch {
    return [];
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

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
    const { data: { user } } = await supabase.auth.getUser();
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
    const { data: { user } } = await supabase.auth.getUser();
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
    const { data: { user } } = await supabase.auth.getUser();
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
    const { data: { user } } = await supabase.auth.getUser();
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
      const { data, error } = await supabase.storage
        .from('clips')
        .createSignedUrl(path, expiresIn);
      if (!error && data?.signedUrl) {
        result[path] = data.signedUrl;
      }
    } catch {
      // Skip failed URLs silently
    }
  });

  await Promise.all(promises);
  return result;
}

/**
 * Generate a signed URL for a reel in the reels bucket.
 */
export async function getSignedReelUrl(
  reelPath: string,
  expiresIn = 3600,
): Promise<string | null> {
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
