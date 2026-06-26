/**
 * Live Golf Course API client
 * Primary: GolfCourseAPI.com (free, ~30K courses worldwide)
 * Docs: https://golfcourseapi.com
 *
 * This module calls the external API directly from the app.
 * Results are cached locally via upsertCourseFromLiveApi() in lib/api.ts.
 */

const GOLF_API_BASE = 'https://api.golfcourseapi.com/v1';

function getApiKey(): string {
  // Read from Expo env (set in .env.local)
  const key = process.env.EXPO_PUBLIC_GOLF_COURSE_API_KEY ?? '';
  if (!key) {
    console.warn('[GolfCourseAPI] No API key configured. Set EXPO_PUBLIC_GOLF_COURSE_API_KEY in .env.local');
  }
  return key;
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
 * Search for golf courses by name.
 * Calls GolfCourseAPI.com directly from the app.
 * Returns an empty array when no API key is configured (graceful degradation).
 *
 * GolfCourseAPI's /v1/search does a global full-text match and IGNORES any
 * country filter — passing `country_code` does nothing, so a search for
 * "Royal Melbourne" returns a US course ahead of the real Australian one.
 * Since our audience is Australian golfers, we rank courses in `countryCode`
 * first (stable within each group) so the relevant local course surfaces at
 * the top of the dropdown instead of being buried under US noise.
 */
export async function searchGolfCoursesLive(
  query: string,
  countryCode = 'AU',
): Promise<GolfCourseSearchResult[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const url = `${GOLF_API_BASE}/search?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        // GolfCourseAPI uses the `Key` scheme, NOT `Bearer`. Passing
        // `Bearer <key>` returns 401 "API Key is missing or invalid".
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[GolfCourseAPI] Search failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    // The API returns courses in various shapes -- normalize + rank AU-first.
    const courses = data.courses ?? data.results ?? [];
    return normalizeAndRankCourses(courses, countryCode);
  } catch (err) {
    console.warn('[GolfCourseAPI] Search error:', err);
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// Course Detail (hole-by-hole data)
// ────────────────────────────────────────────────────────────

/**
 * Get full course detail including hole-by-hole data and tee sets.
 * Returns null when no API key is configured or the request fails.
 */
export async function getGolfCourseDetailLive(
  courseId: string,
): Promise<GolfCourseDetail | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GOLF_API_BASE}/courses/${courseId}`, {
      headers: {
        // GolfCourseAPI uses the `Key` scheme, NOT `Bearer`. Passing
        // `Bearer <key>` returns 401 "API Key is missing or invalid".
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) return null;

    const raw = await res.json();

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
