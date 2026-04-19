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
 * Search for golf courses by name.
 * Calls GolfCourseAPI.com directly from the app.
 * Returns an empty array when no API key is configured (graceful degradation).
 */
export async function searchGolfCoursesLive(
  query: string,
  countryCode = 'AU',
): Promise<GolfCourseSearchResult[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const url = `${GOLF_API_BASE}/search?search_query=${encodeURIComponent(query)}&country_code=${countryCode}`;
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
    // The API returns courses in various shapes -- normalize
    const courses = data.courses ?? data.results ?? [];
    return courses.map((c: any) => ({
      id: String(c.id),
      name: c.club_name ?? c.course_name ?? c.name ?? 'Unknown',
      city: c.city ?? c.location?.city ?? undefined,
      state: c.state ?? c.location?.state ?? undefined,
      country: c.country_code ?? c.country ?? 'AU',
      holes: c.holes ?? c.num_holes ?? 18,
      latitude: c.latitude ?? c.location?.latitude ?? undefined,
      longitude: c.longitude ?? c.location?.longitude ?? undefined,
    }));
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
