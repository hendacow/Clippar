/**
 * Single source of truth for the bundled royalty-free music library.
 *
 * All tracks are sourced from Pixabay under the Pixabay Content License
 * (commercial use allowed, no attribution required — covers user-exported
 * reels). Full provenance (source URLs, download dates, archive snapshots)
 * lives in docs/music-licenses/README.md at the repo root.
 *
 * Audio spec: 44.1 kHz stereo AAC 256 kbps .m4a, loudness-normalized to
 * -14 LUFS integrated / ≤ -1 dBTP true peak (two-pass ffmpeg loudnorm),
 * trimmed to 60–90 s edits with clean intros.
 */
import type { ReelVibe } from '@/lib/onboardingProfile';

export type MusicVibe = ReelVibe; // 'chill' | 'hype' | 'cinematic'

export interface LibraryTrack {
  /** Stable ID — referenced by saved reels; never rename an existing ID. */
  id: string;
  vibe: MusicVibe;
  title: string;
  artist: string;
  durationSeconds: number;
  /** Metro asset module (require()'d) — resolve via expo-asset at export time. */
  asset: number;
  /** Original pre-library tracks kept so existing reels keep resolving. */
  legacy?: boolean;
}

export const MUSIC_LIBRARY: LibraryTrack[] = [
  // ── Hype ────────────────────────────────────────────────────────────────
  {
    id: 'hype_1',
    vibe: 'hype',
    title: 'Motivation Epic Rock',
    artist: 'AlexGrohl',
    durationSeconds: 80,
    asset: require('@/assets/music/hype_1.m4a'),
  },
  {
    id: 'hype_2',
    vibe: 'hype',
    title: 'Epic Sport Rock Trailer',
    artist: 'BFCMUSIC',
    durationSeconds: 85,
    asset: require('@/assets/music/hype_2.m4a'),
  },
  {
    id: 'hype_3',
    vibe: 'hype',
    title: 'Bright Energetic Electronica',
    artist: 'penguinmusic',
    durationSeconds: 87,
    asset: require('@/assets/music/hype_3.m4a'),
  },
  // ── Cinematic ───────────────────────────────────────────────────────────
  {
    id: 'cinematic_1',
    vibe: 'cinematic',
    title: 'Epic Adventure Trailer',
    artist: 'LudoSoundX',
    durationSeconds: 88,
    asset: require('@/assets/music/cinematic_1.m4a'),
  },
  {
    id: 'cinematic_2',
    vibe: 'cinematic',
    title: 'Epic Hollywood Trailer',
    artist: 'Good_B_Music',
    durationSeconds: 80,
    asset: require('@/assets/music/cinematic_2.m4a'),
  },
  {
    id: 'cinematic_3',
    vibe: 'cinematic',
    title: 'Inspiring Cinematic Trailer',
    artist: 'Music_For_Videos',
    durationSeconds: 72,
    asset: require('@/assets/music/cinematic_3.m4a'),
  },
  // ── Chill ───────────────────────────────────────────────────────────────
  {
    id: 'chill_1',
    vibe: 'chill',
    title: 'Lofi Study',
    artist: 'FASSounds',
    durationSeconds: 80,
    asset: require('@/assets/music/chill_1.m4a'),
  },
  {
    id: 'chill_2',
    vibe: 'chill',
    title: 'Modern Chillout (Future Calm)',
    artist: 'penguinmusic',
    durationSeconds: 67,
    asset: require('@/assets/music/chill_2.m4a'),
  },
  {
    id: 'chill_3',
    vibe: 'chill',
    title: 'Just Relax',
    artist: 'Lesfm',
    durationSeconds: 85,
    asset: require('@/assets/music/chill_3.m4a'),
  },
  // ── Legacy (pre-library bundled tracks; kept so old reels still play) ───
  {
    id: 'chill_vibes',
    vibe: 'chill',
    title: 'Chill Vibes',
    artist: 'Clippar',
    durationSeconds: 30,
    asset: require('@/assets/music/chill_vibes.m4a'),
    legacy: true,
  },
  {
    id: 'focus_mode',
    vibe: 'cinematic',
    title: 'Focus Mode',
    artist: 'Clippar',
    durationSeconds: 30,
    asset: require('@/assets/music/focus_mode.m4a'),
    legacy: true,
  },
  {
    id: 'victory_lap',
    vibe: 'hype',
    title: 'Victory Lap',
    artist: 'Clippar',
    durationSeconds: 30,
    asset: require('@/assets/music/victory_lap.m4a'),
    legacy: true,
  },
];

/** All tracks for a vibe, curated (non-legacy) first, in catalogue order. */
export function tracksForVibe(vibe: MusicVibe): LibraryTrack[] {
  return MUSIC_LIBRARY.filter((t) => t.vibe === vibe).sort(
    (a, b) => Number(a.legacy ?? false) - Number(b.legacy ?? false),
  );
}

/** The default (first curated) track for a vibe. */
export function defaultTrackForVibe(vibe: MusicVibe): LibraryTrack {
  const tracks = tracksForVibe(vibe);
  return tracks[0];
}

/**
 * Vibe → default asset module, shape-compatible with the onboarding flow's
 * useVibeMusic / vibeOptions.musicAsset usage (constants/onboardingV2.ts).
 * The onboarding import swap happens post-merge (see PR TODO) — this map is
 * exported now so it is a one-line change there later.
 */
export const VIBE_TRACK: Record<MusicVibe, number> = {
  chill: defaultTrackForVibe('chill').asset,
  cinematic: defaultTrackForVibe('cinematic').asset,
  hype: defaultTrackForVibe('hype').asset,
};

/** id → asset module for every bundled track (new + legacy). */
export const BUNDLED_ASSET_MAP: Record<string, number> = Object.fromEntries(
  MUSIC_LIBRARY.map((t) => [t.id, t.asset]),
);
