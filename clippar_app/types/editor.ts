export interface EditorClip {
  id: string;
  type: 'shot' | 'intro' | 'outro';
  holeNumber: number;
  shotNumber: number;
  sourceUri: string | null; // signed URL from Supabase Storage
  storagePath: string | null; // clips/{roundId}/filename
  thumbnailUri?: string;
  trimStartMs: number;
  trimEndMs: number; // -1 = use full duration
  durationMs: number;
  isExcluded?: boolean;
}

export interface EditorHoleSection {
  holeNumber: number;
  par: number;
  strokes: number;
  scoreToPar: number;
  clips: EditorClip[];
}

export interface EditorState {
  roundId: string;
  courseName: string;
  holes: EditorHoleSection[];
  intro: EditorClip | null;
  outro: EditorClip | null;
  loading: boolean;
  error: string | null;
}
