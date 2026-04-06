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

// ============ Scores ============

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
