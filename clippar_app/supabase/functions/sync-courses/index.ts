/**
 * Supabase Edge Function: sync-courses
 *
 * Fetches golf course data from external APIs and upserts into the
 * courses + holes tables.  Designed to be called:
 *   - manually via POST (admin action)
 *   - on a cron schedule (pg_cron or external scheduler)
 *
 * Supported API sources (in priority order):
 *   1. GolfCourseAPI.com  (free, 300 req/day)
 *   2. GolfAPI.io / mScorecard  (paid, but has AU hole data)
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
 *   GOLF_COURSE_API_KEY   - from golfcourseapi.com (free signup)
 *   GOLF_API_IO_KEY       - from golfapi.io (optional, paid)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ────────────────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────────────────

interface CourseData {
  name: string;
  location_name: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  holes_count: number;
  par_total: number | null;
  slope_rating: number | null;
  course_rating: number | null;
  source: string;
  source_id: string | null;
}

interface HoleData {
  hole_number: number;
  par: number;
  stroke_index: number | null;
  length_meters: number | null;
}

// ────────────────────────────────────────────────────────────
// GolfCourseAPI.com  (free tier: 300 req/day)
//
// Docs: https://golfcourseapi.com
// Base: https://api.golfcourseapi.com/v1
// Auth: Authorization: Bearer <key>
//
// Endpoints:
//   GET /search?search_query=...&country_code=AU
//   GET /courses/<id>
// ────────────────────────────────────────────────────────────

const GCAPI_BASE = 'https://api.golfcourseapi.com/v1';

async function searchGolfCourseAPI(query: string, countryCode = 'AU'): Promise<any[]> {
  const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
  if (!apiKey) return [];

  try {
    const url = `${GCAPI_BASE}/search?search_query=${encodeURIComponent(query)}&country_code=${countryCode}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error(`[GolfCourseAPI] search failed: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.courses ?? data.results ?? [];
  } catch (err) {
    console.error('[GolfCourseAPI] search error:', err);
    return [];
  }
}

async function fetchGolfCourseAPIDetail(courseId: string): Promise<any | null> {
  const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GCAPI_BASE}/courses/${courseId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function mapGolfCourseAPIResponse(raw: any): { course: CourseData; holes: HoleData[] } | null {
  if (!raw || !raw.club_name) return null;

  const course: CourseData = {
    name: raw.club_name || raw.course_name || 'Unknown',
    location_name: raw.city || raw.location?.city || null,
    state: raw.state || raw.location?.state || null,
    country: raw.country_code || raw.location?.country_code || 'AU',
    latitude: raw.latitude ?? raw.location?.latitude ?? null,
    longitude: raw.longitude ?? raw.location?.longitude ?? null,
    holes_count: raw.holes ?? 18,
    par_total: null,
    slope_rating: null,
    course_rating: null,
    source: 'golfcourseapi',
    source_id: String(raw.id),
  };

  const holes: HoleData[] = [];
  const tees = raw.tees || raw.scorecard?.tees || [];

  // Try to find a standard men's tee
  const mensTee = tees.find((t: any) =>
    /blue|white|men|regular/i.test(t.tee_name || t.name || '')
  ) || tees[0];

  if (mensTee?.holes) {
    let parTotal = 0;
    for (const h of mensTee.holes) {
      const par = h.par ?? 4;
      parTotal += par;
      holes.push({
        hole_number: h.hole_number ?? h.number,
        par,
        stroke_index: h.handicap ?? h.stroke_index ?? null,
        length_meters: h.yards ? Math.round(h.yards * 0.9144) : (h.meters ?? null),
      });
    }
    course.par_total = parTotal;
    course.slope_rating = mensTee.slope ?? null;
    course.course_rating = mensTee.course_rating ?? null;
  }

  return { course, holes };
}

// ────────────────────────────────────────────────────────────
// GolfAPI.io / mScorecard  (paid, richer AU data)
//
// Base: https://golfapi.mscorecard.com/api/v1
// Auth: Authorization: Bearer <key>
//
// Endpoints:
//   GET /clubs?country=AU&state=QLD&name=...
//   GET /clubs/{id}
//   GET /courses/{id}
// ────────────────────────────────────────────────────────────

const GOLFAPIIO_BASE = 'https://golfapi.mscorecard.com/api/v1';

async function searchGolfApiIo(query: string, country = 'AU', state = 'QLD'): Promise<any[]> {
  const apiKey = Deno.env.get('GOLF_API_IO_KEY');
  if (!apiKey) return [];

  try {
    const url = `${GOLFAPIIO_BASE}/clubs?name=${encodeURIComponent(query)}&country=${country}&state=${state}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.clubs ?? [];
  } catch {
    return [];
  }
}

async function fetchGolfApiIoCourse(courseId: string): Promise<any | null> {
  const apiKey = Deno.env.get('GOLF_API_IO_KEY');
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GOLFAPIIO_BASE}/courses/${courseId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function mapGolfApiIoResponse(raw: any): { course: CourseData; holes: HoleData[] } | null {
  if (!raw) return null;

  const course: CourseData = {
    name: raw.name || raw.course_name || 'Unknown',
    location_name: raw.city || null,
    state: raw.state || null,
    country: raw.country || 'AU',
    latitude: raw.latitude ?? null,
    longitude: raw.longitude ?? null,
    holes_count: raw.holes_count || 18,
    par_total: null,
    slope_rating: null,
    course_rating: null,
    source: 'golfapiio',
    source_id: String(raw.id),
  };

  const holes: HoleData[] = [];

  // mScorecard returns tees array, each with holes
  const tees = raw.tees || [];
  const mensTee = tees.find((t: any) =>
    /blue|white|men|regular/i.test(t.name || '')
  ) || tees[0];

  if (mensTee?.holes) {
    let parTotal = 0;
    for (const h of mensTee.holes) {
      const par = h.par ?? 4;
      parTotal += par;
      holes.push({
        hole_number: h.number,
        par,
        stroke_index: h.si ?? h.stroke_index ?? null,
        length_meters: h.meters ?? (h.yards ? Math.round(h.yards * 0.9144) : null),
      });
    }
    course.par_total = parTotal;
    course.slope_rating = mensTee.slope ?? null;
    course.course_rating = mensTee.rating ?? null;
  }

  return { course, holes };
}

// ────────────────────────────────────────────────────────────
// Database upsert logic
// ────────────────────────────────────────────────────────────

async function upsertCourse(courseData: CourseData, holesData: HoleData[]): Promise<string | null> {
  // Try to find existing course by source + source_id or by name
  let courseId: string | null = null;

  if (courseData.source_id) {
    const { data: existing } = await supabase
      .from('courses')
      .select('id')
      .eq('source', courseData.source)
      .eq('source_id', courseData.source_id)
      .maybeSingle();
    courseId = existing?.id ?? null;
  }

  if (!courseId) {
    // Fallback: match by name (fuzzy)
    const { data: existing } = await supabase
      .from('courses')
      .select('id')
      .ilike('name', courseData.name)
      .eq('country', courseData.country)
      .maybeSingle();
    courseId = existing?.id ?? null;
  }

  if (courseId) {
    // Update existing
    await supabase
      .from('courses')
      .update({
        location_name: courseData.location_name,
        state: courseData.state,
        latitude: courseData.latitude,
        longitude: courseData.longitude,
        holes_count: courseData.holes_count,
        par_total: courseData.par_total,
        slope_rating: courseData.slope_rating ?? undefined,
        course_rating: courseData.course_rating ?? undefined,
        source_id: courseData.source_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', courseId);
  } else {
    // Insert new
    const { data: inserted, error } = await supabase
      .from('courses')
      .insert(courseData)
      .select('id')
      .single();
    if (error) {
      console.error('[upsertCourse] insert error:', error.message);
      return null;
    }
    courseId = inserted.id;
  }

  // Upsert holes
  if (holesData.length > 0 && courseId) {
    for (const hole of holesData) {
      await supabase
        .from('holes')
        .upsert(
          {
            course_id: courseId,
            hole_number: hole.hole_number,
            par: hole.par,
            stroke_index: hole.stroke_index,
            length_meters: hole.length_meters,
          },
          { onConflict: 'course_id,hole_number' }
        );
    }
  }

  return courseId;
}

// ────────────────────────────────────────────────────────────
// Main handler
// ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'sync_region';

    // ── Action: sync_region ─────────────────────────────────
    // Syncs courses for a region (default: QLD, AU)
    if (action === 'sync_region') {
      const country = body.country || 'AU';
      const state = body.state || 'QLD';
      const searchTerms = body.search_terms || [
        'Brisbane', 'Gold Coast', 'Sunshine Coast',
        'Ipswich', 'Toowoomba', 'Redland', 'Logan',
      ];

      let synced = 0;
      let errors = 0;

      for (const term of searchTerms) {
        // Try GolfCourseAPI first (free)
        let results = await searchGolfCourseAPI(term, country);

        for (const result of results) {
          try {
            const detail = await fetchGolfCourseAPIDetail(String(result.id));
            const mapped = mapGolfCourseAPIResponse(detail || result);
            if (mapped) {
              // Override state from search context
              mapped.course.state = state;
              await upsertCourse(mapped.course, mapped.holes);
              synced++;
            }
          } catch {
            errors++;
          }
        }

        // Then try GolfAPI.io if key is available
        const golfApiResults = await searchGolfApiIo(term, country, state);
        for (const club of golfApiResults) {
          try {
            if (club.courses) {
              for (const course of club.courses) {
                const detail = await fetchGolfApiIoCourse(String(course.id));
                const mapped = mapGolfApiIoResponse(detail || course);
                if (mapped) {
                  await upsertCourse(mapped.course, mapped.holes);
                  synced++;
                }
              }
            }
          } catch {
            errors++;
          }
        }

        // Rate limit courtesy: small delay between search batches
        await new Promise((r) => setTimeout(r, 500));
      }

      return new Response(
        JSON.stringify({ success: true, synced, errors }),
        { headers: corsHeaders }
      );
    }

    // ── Action: sync_single ─────────────────────────────────
    // Sync a single course by name
    if (action === 'sync_single') {
      const name = body.name;
      if (!name) {
        return new Response(
          JSON.stringify({ error: 'name is required' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Try GolfCourseAPI
      const results = await searchGolfCourseAPI(name, body.country || 'AU');
      if (results.length > 0) {
        const detail = await fetchGolfCourseAPIDetail(String(results[0].id));
        const mapped = mapGolfCourseAPIResponse(detail || results[0]);
        if (mapped) {
          const id = await upsertCourse(mapped.course, mapped.holes);
          return new Response(
            JSON.stringify({ success: true, course_id: id, source: 'golfcourseapi' }),
            { headers: corsHeaders }
          );
        }
      }

      // Fallback: GolfAPI.io
      const golfApiResults = await searchGolfApiIo(name);
      if (golfApiResults.length > 0 && golfApiResults[0].courses?.length > 0) {
        const courseId = golfApiResults[0].courses[0].id;
        const detail = await fetchGolfApiIoCourse(String(courseId));
        const mapped = mapGolfApiIoResponse(detail);
        if (mapped) {
          const id = await upsertCourse(mapped.course, mapped.holes);
          return new Response(
            JSON.stringify({ success: true, course_id: id, source: 'golfapiio' }),
            { headers: corsHeaders }
          );
        }
      }

      return new Response(
        JSON.stringify({ success: false, error: 'Course not found in any API' }),
        { status: 404, headers: corsHeaders }
      );
    }

    // ── Action: approve_suggestion ──────────────────────────
    // Admin: approve a community-submitted course suggestion
    if (action === 'approve_suggestion') {
      const suggestionId = body.suggestion_id;
      if (!suggestionId) {
        return new Response(
          JSON.stringify({ error: 'suggestion_id is required' }),
          { status: 400, headers: corsHeaders }
        );
      }

      const { data: suggestion, error } = await supabase
        .from('course_suggestions')
        .select('*')
        .eq('id', suggestionId)
        .single();

      if (error || !suggestion) {
        return new Response(
          JSON.stringify({ error: 'Suggestion not found' }),
          { status: 404, headers: corsHeaders }
        );
      }

      const courseData: CourseData = {
        name: suggestion.course_name,
        location_name: suggestion.location_name,
        state: suggestion.state,
        country: suggestion.country,
        latitude: null,
        longitude: null,
        holes_count: suggestion.holes_count || 18,
        par_total: suggestion.par_total,
        slope_rating: null,
        course_rating: null,
        source: 'community',
        source_id: suggestionId,
      };

      const holesData: HoleData[] = [];
      if (suggestion.hole_data && Array.isArray(suggestion.hole_data)) {
        for (const h of suggestion.hole_data) {
          holesData.push({
            hole_number: h.holeNumber,
            par: h.par,
            stroke_index: h.strokeIndex ?? null,
            length_meters: h.lengthMeters ?? null,
          });
        }
      }

      const courseId = await upsertCourse(courseData, holesData);

      // Mark suggestion as approved
      await supabase
        .from('course_suggestions')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', suggestionId);

      return new Response(
        JSON.stringify({ success: true, course_id: courseId }),
        { headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: corsHeaders }
    );
  } catch (err) {
    console.error('[sync-courses] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
