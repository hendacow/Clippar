/**
 * Web stubs for storage.ts — expo-sqlite WASM doesn't resolve on web.
 * Metro automatically uses .web.ts files on the web platform.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

export async function getDatabase(): Promise<any> {
  throw new Error('SQLite not available on web');
}

export async function saveLocalClip(_clip: {
  round_id: string;
  hole_number: number;
  shot_number: number;
  file_uri: string;
  gps_latitude?: number;
  gps_longitude?: number;
  duration_seconds?: number;
}) {}

export async function getUnuploadedClips(_roundId: string) {
  return [];
}

export async function markClipUploaded(_clipId: number, _remoteClipId: string) {}

export async function getClipsForRound(_roundId: string) {
  return [];
}

export async function saveLocalRound(_round: {
  id: string;
  course_name: string;
  course_id?: string;
}) {}

export async function getOrphanedRounds() {
  return [];
}

export async function getLocalRound(_roundId: string) {
  return null;
}

export async function updateLocalRound(
  _id: string,
  _updates: {
    current_hole?: number;
    current_shot?: number;
    status?: string;
    finished_at?: string;
  }
) {}

export async function saveLocalScore(_score: {
  round_id: string;
  hole_number: number;
  strokes: number;
  putts: number;
  penalty_strokes: number;
  is_pickup: boolean;
  par: number;
}) {}

export async function getLocalScores(_roundId: string) {
  return [];
}

export async function incrementClipRetryCount(_clipId: number) {}

export async function deleteLocalRound(_roundId: string) {}

// Generic key/value settings — backed by localStorage on web
export async function getSetting(key: string): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(`clippar.${key}`);
    }
  } catch {}
  return null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (value === null) {
        window.localStorage.removeItem(`clippar.${key}`);
      } else {
        window.localStorage.setItem(`clippar.${key}`, value);
      }
    }
  } catch {}
}

