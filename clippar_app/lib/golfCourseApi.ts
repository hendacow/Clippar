/**
 * Live Golf Course API client
 * Primary: GolfCourseAPI.com (free, ~30K courses worldwide)
 * Docs: https://golfcourseapi.com
 *
 * This module goes through the `search-courses` edge function; it does NOT talk
 * to api.golfcourseapi.com and it holds no credential.
 *
 * Why: it used to fetch that API directly with
 * `Authorization: Key ${process.env.EXPO_PUBLIC_GOLF_COURSE_API_KEY}`. Expo
 * inlines EXPO_PUBLIC_* into the JS bundle at build time, so the key shipped
 * inside the IPA and came back out with `strings` on the Hermes bundle. The free
 * tier is 300 requests/day ACCOUNT-WIDE, so anyone holding the extracted key
 * could exhaust a whole day of course search in seconds with a curl loop — no
 * account, no install, repeatable daily — and because no Clippar server sat in
 * the path, no rate limiter could see it. Rotating the key also meant a new
 * binary through App Review. The key now lives as a Supabase secret and every
 * call is metered per caller plus a project-wide daily budget.
 *
 * Both entry points still degrade to [] / null on any failure, so an exhausted
 * or unreachable upstream shows fewer suggestions rather than a broken screen.
 * Results are cached locally via upsertCourseFromLiveApi() in lib/api.ts.
 */

/**
 * Loaded lazily so this module stays importable in the node:test suite — the
 * Supabase client pulls in react-native, expo-secure-store and AsyncStorage,
 * none of which exist under `node --test`, and the pure helpers below are
 * covered there.
 */
async function invokeSearchCourses<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const { supabase } = await import('./supabase');
    const { data, error } = await supabase.functions.invoke('search-courses', { body });
    if (error) {
      console.warn('[GolfCourseAPI] search-courses error:', error.message ?? error);
      return null;
    }
    return (data ?? null) as T | null;
  } catch (err) {
    console.warn('[GolfCourseAPI] search-courses invoke failed:', err);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface GolfCourseSearchResult {
  id: string;
  name: string;
  city?: string;
  state?: string;
  country: string;
  holes?: number;
  latitude?: number;
  longitude?: number;
}

export interface GolfCourseHoleData {
  number: number;
  par: number;
  yardage?: number;
  metres?: number;
  handicap?: number; // stroke index
}

export interface GolfCourseTeeSet {
  name: string;
  gender?: string;
  totalYardage?: number;
  totalMetres?: number;
  slope?: number;
  rating?: number;
  holes: GolfCourseHoleData[];
}

export interface GolfCourseDetail {
  id: string;
  name: string;
  city?: string;
  state?: string;
  country: string;
  holes: number;
  tees: GolfCourseTeeSet[];
}

// ────────────────────────────────────────────────────────────
// Search
// ────────────────────────────────────────────────────────────

/**
 * Map the API's free-text country field to a 2-letter code.
 * The /v1/search endpoint returns country as a full name nested under
 * `location.country` (e.g. "Australia", "United States") — there is no
 * top-level `country_code`. We normalise it so results can be ranked by
 * country below.
 */
export function normalizeCountryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'au' || v === 'australia') return 'AU';
  if (v === 'us' || v === 'usa' || v === 'united states') return 'US';
  if (v === 'gb' || v === 'uk' || v === 'united kingdom') return 'GB';
  if (v === 'nz' || v === 'new zealand') return 'NZ';
  if (v === 'ca' || v === 'canada') return 'CA';
  // Already a 2-letter code? keep it uppercased. Otherwise pass the name through.
  return v.length === 2 ? v.toUpperCase() : raw.trim();
}

/**
 * Normalise the raw /v1/search course array into our result shape and rank
 * by country. Pure (no network) so it can be unit-tested. The API can't
 * filter by country, so we rank client-side: target country first, then
 * untagged/ungeocoded courses (often local ones the API didn't tag), then
 * everything else. Stable within each group to preserve API relevance order.
 */
export function normalizeAndRankCourses(
  rawCourses: any[],
  countryCode = 'AU',
): GolfCourseSearchResult[] {
  const want = countryCode.toUpperCase();

  // Keep the *real* normalised country (may be undefined when the API didn't
  // geocode the course) for ranking, separate from the result's `country`
  // field which keeps the historical 'AU' fallback for downstream callers.
  const mapped = (rawCourses ?? []).map((c: any) => {
    // Country lives at `location.country` as a full name; there is no
    // top-level `country_code`/`country`. Reading those (as before) made
    // every result collapse to the 'AU' fallback.
    const normalized = normalizeCountryCode(
      c.location?.country ?? c.country_code ?? c.country,
    );
    const result: GolfCourseSearchResult = {
      id: String(c.id),
      name: c.club_name ?? c.course_name ?? c.name ?? 'Unknown',
      city: c.city ?? c.location?.city ?? undefined,
      state: c.state ?? c.location?.state ?? undefined,
      country: normalized ?? 'AU',
      holes: c.holes ?? c.num_holes ?? 18,
      latitude: c.latitude ?? c.location?.latitude ?? undefined,
      longitude: c.longitude ?? c.location?.longitude ?? undefined,
    };
    return { result, normalized };
  });

  const rank = (normalized: string | undefined): number => {
    if (normalized === want) return 0; // target country
    if (!normalized) return 1; // ungeocoded — often a local course untagged
    return 2; // a different country
  };
  return mapped
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m.normalized) - rank(b.m.normalized) || a.i - b.i)
    .map(({ m }) => m.result);
}

/**
 * Search for golf courses by name, via the `search-courses` edge function.
 * Returns an empty array on any failure or when the daily upstream budget is
 * spent (graceful degradation — callers merge these with local results).
 *
 * GolfCourseAPI's /v1/search does a global full-text match and IGNORES any
 * country filter — passing `country_code` does nothing, so a search for
 * "Royal Melbourne" returns a US course ahead of the real Australian one.
 * Since our audience is Australian golfers, we rank courses in `countryCode`
 * first (stable within each group) so the relevant local course surfaces at
 * the top of the dropdown instead of being buried under US noise. That ranking
 * stays here on the client because it is presentation, not authorization.
 */
export async function searchGolfCoursesLive(
  query: string,
  countryCode = 'AU',
): Promise<GolfCourseSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const data = await invokeSearchCourses<{ courses?: any[] }>({
    action: 'search',
    query: trimmed,
    country: countryCode,
  });
  if (!data) return [];

  // The API returns courses in various shapes -- normalize + rank AU-first.
  return normalizeAndRankCourses(data.courses ?? [], countryCode);
}

// ────────────────────────────────────────────────────────────
// Course Detail (hole-by-hole data)
// ────────────────────────────────────────────────────────────

/**
 * Get full course detail including hole-by-hole data and tee sets, via the
 * `search-courses` edge function. Returns null when the request fails or the
 * upstream is unavailable.
 */
export async function getGolfCourseDetailLive(
  courseId: string,
): Promise<GolfCourseDetail | null> {
  const data = await invokeSearchCourses<{ course?: any }>({
    action: 'detail',
    course_id: courseId,
  });
  const raw = data?.course;
  if (!raw) return null;

  try {
    // Parse tee sets and hole data
    const tees: GolfCourseTeeSet[] = [];
    const rawTees = raw.tees ?? raw.scorecard?.tees ?? [];

    for (const t of rawTees) {
      const holes: GolfCourseHoleData[] = [];
      const rawHoles = t.holes ?? [];

      for (const h of rawHoles) {
        holes.push({
          number: h.hole_number ?? h.number,
          par: h.par ?? 4,
          yardage: h.yards ?? h.yardage ?? undefined,
          metres: h.meters ?? h.metres ?? (h.yards ? Math.round(h.yards * 0.9144) : undefined),
          handicap: h.handicap ?? h.stroke_index ?? undefined,
        });
      }

      tees.push({
        name: t.tee_name ?? t.name ?? 'Default',
        gender: t.gender ?? undefined,
        totalYardage: t.total_yards ?? t.total_yardage ?? undefined,
        totalMetres: t.total_meters ?? t.total_metres ?? undefined,
        slope: t.slope ?? t.slope_rating ?? undefined,
        rating: t.course_rating ?? t.rating ?? undefined,
        holes: holes.sort((a, b) => a.number - b.number),
      });
    }

    return {
      id: String(raw.id),
      name: raw.club_name ?? raw.course_name ?? raw.name ?? 'Unknown',
      city: raw.city ?? raw.location?.city ?? undefined,
      state: raw.state ?? raw.location?.state ?? undefined,
      country: raw.country_code ?? raw.country ?? 'AU',
      holes: raw.holes ?? raw.num_holes ?? 18,
      tees,
    };
  } catch (err) {
    console.warn('[GolfCourseAPI] Detail error:', err);
    return null;
  }
}
