// Course preset — captures the per-round setup choices the user makes for
// a course so they can skip the setup screens on repeat visits. See
// supabase/migrations/009_course_presets.sql for the source schema.
export type CoursePreset = {
  id: string;
  user_id: string;
  course_id: string | null;
  course_name: string;
  holes_played: 9 | 18;
  start_hole: 1 | 10;
  // ms of clip duration. null = inherit the app/user default.
  trim_duration_ms: number | null;
  name: string;
  last_used_at: string; // ISO timestamp
  created_at: string;
  updated_at: string;
};

// What the caller must provide to create a preset. Everything else is
// defaulted by the database (id, timestamps) or pulled from the auth
// context (user_id is injected by the API helper).
export type CoursePresetInput = {
  course_id: string | null;
  course_name: string;
  holes_played: 9 | 18;
  start_hole: 1 | 10;
  trim_duration_ms?: number | null;
  // If omitted, the API helper derives a sensible default like
  // 'Riversdale GC — 18 holes'.
  name?: string;
};

// Convenience: build the auto-generated display name used when the user
// doesn't provide one. Centralised here so the UI and the API agree.
export function defaultPresetName(input: {
  course_name: string;
  holes_played: 9 | 18;
}): string {
  return `${input.course_name} — ${input.holes_played} holes`;
}
