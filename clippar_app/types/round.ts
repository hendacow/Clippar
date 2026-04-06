export interface HoleScore {
  holeNumber: number;
  par: number;
  strokes: number;
  putts: number;
  penaltyStrokes: number;
  isPickup: boolean;
  scoreToPar: number;
}

export interface ClipMetadata {
  id?: number;
  roundId: string;
  holeNumber: number;
  shotNumber: number;
  fileUri: string;
  gpsLatitude?: number;
  gpsLongitude?: number;
  durationSeconds?: number;
  timestamp: string;
  uploaded: boolean;
}

export interface HoleData {
  holeNumber: number;
  par: number;
  strokeIndex?: number;
  lengthMeters?: number;
}

export interface RoundState {
  roundId: string;
  courseId?: string;
  courseName: string;
  currentHole: number;
  currentShot: number;
  isRecording: boolean;
  scores: HoleScore[];
  clips: ClipMetadata[];
  totalScore: number;
  totalPar: number;
  courseHoles?: HoleData[];
  status: 'not_started' | 'in_progress' | 'finished' | 'uploading' | 'processing' | 'ready';
}

export type Round = {
  id: string;
  user_id: string;
  course_id: string | null;
  course_name: string;
  date: string;
  total_score: number | null;
  total_par: number | null;
  score_to_par: number | null;
  total_putts: number | null;
  holes_played: number;
  status: 'recording' | 'uploading' | 'processing' | 'ready' | 'failed';
  reel_url: string | null;
  reel_duration_seconds: number | null;
  thumbnail_url: string | null;
  is_published: boolean;
  share_token: string | null;
  created_at: string;
  updated_at: string;
};

export type PenaltyType = 'lost_ball' | 'water_hazard' | 'out_of_bounds' | 'pickup';

export const PENALTY_STROKES: Record<PenaltyType, number> = {
  lost_ball: 2,
  water_hazard: 1,
  out_of_bounds: 2,
  pickup: 0, // pickup uses special scoring
};

export const PENALTY_LABELS: Record<PenaltyType, string> = {
  lost_ball: 'Lost Ball (+2)',
  water_hazard: 'Water Hazard (+1)',
  out_of_bounds: 'Out of Bounds (+2)',
  pickup: 'Pickup (Net Double Bogey)',
};
