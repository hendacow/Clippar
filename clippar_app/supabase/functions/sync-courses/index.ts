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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { enforceRateLimits } from '../_shared/rateLimit.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

/**
 * Is this user an admin? Checks the `admin_users` table by id or email using
 * the service-role client (RLS-bypassing). Admin-only actions
 * (approve_suggestion, sync_region) gate on this; the everyday search-fallback
 * action (sync_single) only requires a valid signed-in user.
 */
async function isAdminUser(
  userId: string,
  email: string | null | undefined,
): Promise<boolean> {
  const { data: byId } = await supabase
    .from('admin_users')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  if (byId) return true;

  if (email) {
    const { data: byEmail } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (byEmail) return true;
  }
  return false;
}

// Per-user daily cap for the course-sync actions. sync_single is reachable by
// any signed-in user and each call can drive service-role catalog writes +
// external-API quota, so cap how many a single account can make per UTC day.
// Generous enough that ordinary course search never hits it. The counter lives
// in the service-role-only `sync_course_usage` table (no client RLS access), so
// a user cannot inspect or reset it.
const MAX_SYNC_CALLS_PER_DAY = 20;

/**
 * Returns a 429 Response if the user is at/over the daily cap; otherwise records
 * this call and returns null.
 *
 * This used to SELECT the count, compare it, then UPSERT count + 1 against the
 * `sync_course_usage` table, and its own comment conceded that the increment
 * "can race under heavy concurrency" while calling a small overshoot acceptable.
 * The overshoot is not small. An attacker does not send requests one at a time —
 * fire 200 concurrently, every one reads the same pre-increment value, every one
 * passes the comparison, and 20-a-day is not a limit at all.
 *
 * Now delegates to the shared limiter, where the increment and the read are a
 * single INSERT ... ON CONFLICT DO UPDATE ... RETURNING. Concurrent callers
 * serialise on the row lock and each sees a distinct count. Same cap, same
 * response shape, no race. See migration 016.
 */
async function enforceDailySyncCap(
  userId: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  return enforceRateLimits(
    supabase,
    { bucket: 'sync-courses', limit: MAX_SYNC_CALLS_PER_DAY, windowSeconds: 86_400 },
    userId,
    corsHeaders,
  );
}

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

/**
 * Coerce a caller-supplied region code to an ISO-3166-ish / state-code shape:
 * 2–3 ASCII letters, uppercased. Anything else falls back to the default.
 *
 * `sync_single` is deliberately open to any signed-in user and takes
 * `body.country` straight from the request. That value used to be interpolated
 * into the outbound query string UNENCODED, so `"AU&limit=10000"` appended
 * attacker-chosen parameters — and `"AU#"` truncated ours — on a request that
 * carries our paid GOLF_COURSE_API_KEY in the Authorization header. Encoding
 * alone stops the injection; the allowlist shape also stops us wasting quota on
 * a garbage upstream query. Both, because encoding is one refactor away from
 * being dropped again.
 */
export function safeRegionCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2,3}$/.test(trimmed) ? trimmed : fallback;
}

async function searchGolfCourseAPI(query: string, countryCode = 'AU'): Promise<any[]> {
  const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
  if (!apiKey) return [];

  try {
    const url = `${GCAPI_BASE}/search?search_query=${encodeURIComponent(query)}` +
      `&country_code=${encodeURIComponent(countryCode)}`;
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
    // courseId is upstream-supplied rather than client-supplied, but it is still
    // interpolated into a path — encode it so a value containing `/`, `?` or `#`
    // cannot re-point the request at a different endpoint on that host.
    const res = await fetch(`${GCAPI_BASE}/courses/${encodeURIComponent(courseId)}`, {
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
    // Same parameter-pollution guard as searchGolfCourseAPI: `country`/`state`
    // trace back to the request body on the sync_region path, and this request
    // carries our paid GOLF_API_IO_KEY.
    const url = `${GOLFAPIIO_BASE}/clubs?name=${encodeURIComponent(query)}` +
      `&country=${encodeURIComponent(country)}&state=${encodeURIComponent(state)}`;
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
    const res = await fetch(`${GOLFAPIIO_BASE}/courses/${encodeURIComponent(courseId)}`, {
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

/**
 * Escape LIKE/ILIKE metacharacters so a value is matched literally rather than
 * as a wildcard pattern. Backslash must be escaped first.
 *
 * `*` is in the set because PostgREST — not Postgres — is the parser here.
 * supabase-js emits `.ilike(col, pattern)` as the raw filter `col=ilike.<pattern>`
 * and PostgREST rewrites `*` to `%` before Postgres ever sees the string. So the
 * original class of `\ % _` left `*` behaving as a full wildcard, which is
 * exactly what this function's own contract says must not happen: a community
 * suggestion named `Royal *` matches one real catalog row, and approving it
 * takes the UPDATE branch of upsertCourse and overwrites that shared course's
 * location, coordinates, hole count and par with attacker-chosen values.
 *
 * Escaping `*` is not perfect — PostgREST rewrites the escaped `\*` to `\%`, so
 * a name genuinely containing `*` ends up looking for a literal `%` and simply
 * misses. That is the safe direction: a miss inserts a new row, it does not
 * overwrite someone else's. isExactNameMatch() below is the real backstop.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_*]/g, (c) => `\\${c}`);
}

/**
 * Confirm a row returned by the ILIKE lookup really is the same name, ignoring
 * case only.
 *
 * The escape above depends on knowing every metacharacter PostgREST and Postgres
 * treat specially, and that list has already been wrong once. This check does
 * not depend on it: whatever pattern goes over the wire, the row we act on must
 * still be a case-insensitive exact match, so a wildcard that slips through
 * selects nothing rather than selecting — and then overwriting — an unrelated
 * course.
 */
export function isExactNameMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Validate one entry of a community suggestion's `hole_data` blob before it is
 * written to the shared `holes` table. Returns null for anything that isn't a
 * plausible golf hole, so the row is dropped rather than stored.
 *
 * These came in as unvalidated user JSON: `hole_number` and `par` were read
 * straight off the object and upserted. A suggestion carrying
 * `{"holeNumber": 1e9, "par": -4}` corrupts scorecards and score-to-par for
 * every user who later selects that course, and an admin approving a course
 * name has no way to see it.
 */
export function parseSuggestedHole(h: unknown): HoleData | null {
  if (!h || typeof h !== 'object') return null;
  const raw = h as Record<string, unknown>;

  const int = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null;

  const holeNumber = int(raw.holeNumber);
  const par = int(raw.par);
  // A course can have up to 18 holes here (holes_count is capped at 18 upstream);
  // par 3 is the shortest real hole and par 6 exists on a handful of courses.
  if (holeNumber === null || holeNumber < 1 || holeNumber > 18) return null;
  if (par === null || par < 3 || par > 6) return null;

  const strokeIndex = int(raw.strokeIndex);
  const lengthMeters = int(raw.lengthMeters);

  return {
    hole_number: holeNumber,
    par,
    stroke_index:
      strokeIndex !== null && strokeIndex >= 1 && strokeIndex <= 18
        ? strokeIndex
        : null,
    // Longest hole ever played is well under 1000 m; anything past that is junk.
    length_meters:
      lengthMeters !== null && lengthMeters > 0 && lengthMeters <= 1000
        ? lengthMeters
        : null,
  };
}

async function upsertCourse(
  courseData: CourseData,
  holesData: HoleData[],
  insertOnly = false,
): Promise<string | null> {
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
    // Fallback: match by name (case-insensitive exact, metacharacters escaped)
    const { data: existing } = await supabase
      .from('courses')
      .select('id, name')
      .ilike('name', escapeLikePattern(courseData.name))
      .eq('country', courseData.country)
      .maybeSingle();
    // Re-check the returned name here rather than trusting the pattern. See
    // isExactNameMatch: this is what makes a leaked wildcard a miss instead of
    // a catalog overwrite.
    courseId =
      existing && isExactNameMatch(existing.name ?? '', courseData.name)
        ? existing.id
        : null;
  }

  if (courseId) {
    // An existing shared-catalog row matched.
    if (insertOnly) {
      // Untrusted caller (sync_single): never UPDATE an existing course or
      // overwrite its holes on behalf of an arbitrary authenticated user — that
      // would let anyone rewrite the shared catalog by passing a colliding
      // name. Return the existing id so search still resolves, but leave the
      // row and its holes untouched.
      return courseId;
    }
    // Update existing (trusted admin / bulk-sync flows only)
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

const handler = async (req: Request): Promise<Response> => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── Authenticate the caller ─────────────────────────────
    // The platform default (verify_jwt=true) only proves the request carries a
    // valid signed JWT — the public anon key satisfies that. Resolve an actual
    // end user here and reject anonymous/anon-key calls outright.
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: corsHeaders }
      );
    }
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: corsHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'sync_region';

    // Privileged actions promote community data into the live catalog
    // (approve_suggestion) or fan out bulk paid-API syncs (sync_region), and
    // must be admin-only. sync_single is the everyday course-search fallback
    // and stays available to any signed-in user.
    if (action === 'approve_suggestion' || action === 'sync_region') {
      if (!(await isAdminUser(user.id, user.email))) {
        return new Response(
          JSON.stringify({ error: 'Forbidden' }),
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // Per-user daily cap on the catalog-sync actions (sync_single is open to
    // any signed-in user; sync_region is admin-only but still quota-bearing).
    if (action === 'sync_single' || action === 'sync_region') {
      const capped = await enforceDailySyncCap(user.id, corsHeaders);
      if (capped) return capped;
    }

    // ── Action: sync_region ─────────────────────────────────
    // Syncs courses for a region (default: QLD, AU)
    if (action === 'sync_region') {
      // Shape-checked, not passed through: these end up in an outbound query
      // string on a request carrying our paid API keys. See safeRegionCode.
      const country = safeRegionCode(body.country, 'AU');
      const state = safeRegionCode(body.state, 'QLD');
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
      // sync_single is the one action any signed-in user can reach, so its DTO
      // gets checked rather than trusted: a non-string or oversized `name` goes
      // into an outbound API call and then into the shared catalog.
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) {
        return new Response(
          JSON.stringify({ error: 'name is required' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Try GolfCourseAPI
      const results = await searchGolfCourseAPI(name, safeRegionCode(body.country, 'AU'));
      if (results.length > 0) {
        const detail = await fetchGolfCourseAPIDetail(String(results[0].id));
        const mapped = mapGolfCourseAPIResponse(detail || results[0]);
        if (mapped) {
          // insertOnly: sync_single is reachable by any signed-in user, so it
          // must never mutate an existing shared course.
          const id = await upsertCourse(mapped.course, mapped.holes, true);
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
          // insertOnly: see note above — never overwrite the shared catalog.
          const id = await upsertCourse(mapped.course, mapped.holes, true);
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

      // `hole_data` is free-form JSON a community member wrote. It goes straight
      // into the shared `holes` table, which every user's scorecard and
      // score-to-par is computed from, so validate the shape here — an admin
      // approving a suggestion is approving the COURSE, not vouching for the
      // numeric range of every field in a blob they never see.
      const holesData: HoleData[] = [];
      if (Array.isArray(suggestion.hole_data)) {
        for (const h of suggestion.hole_data) {
          const parsed = parseSuggestedHole(h);
          if (parsed) holesData.push(parsed);
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
      JSON.stringify({ error: 'Unknown action' }),
      { status: 400, headers: corsHeaders }
    );
  } catch (err) {
    // Log the detail, return a stable public string. `message: String(err)`
    // relayed whatever Postgres, the Supabase client or a third-party SDK
    // happened to say — column names, constraint names, request ids, internal
    // hostnames, dependency versions — which is free reconnaissance (spec 5.3).
    console.error('[sync-courses] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: corsHeaders }
    );
  }
};

// Guarded so `deno test` can import the pure helpers without binding a port
// (same pattern as delete-account / revenuecat-webhook).
if (import.meta.main) {
  Deno.serve(handler);
}
