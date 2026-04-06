// Mock data for development preview — remove when connected to live Supabase
export const MOCK_ROUNDS = [
  {
    id: '1',
    course_name: 'Royal Melbourne West',
    date: '2026-04-03',
    total_score: 78,
    total_par: 72,
    score_to_par: 6,
    total_putts: 32,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel1.mp4',
    thumbnail_url: null,
    clips_count: 14,
    best_hole: { hole: 7, par: 3, score: 2, label: 'Birdie' },
  },
  {
    id: '2',
    course_name: 'Kingston Heath',
    date: '2026-03-29',
    total_score: 82,
    total_par: 72,
    score_to_par: 10,
    total_putts: 34,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel2.mp4',
    thumbnail_url: null,
    clips_count: 16,
    best_hole: { hole: 12, par: 4, score: 4, label: 'Par' },
  },
  {
    id: '3',
    course_name: 'Huntingdale',
    date: '2026-03-22',
    total_score: 75,
    total_par: 72,
    score_to_par: 3,
    total_putts: 29,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel3.mp4',
    thumbnail_url: null,
    clips_count: 12,
    best_hole: { hole: 3, par: 5, score: 3, label: 'Eagle' },
  },
  {
    id: '4',
    course_name: 'Yarra Yarra',
    date: '2026-03-15',
    total_score: 80,
    total_par: 72,
    score_to_par: 8,
    total_putts: 33,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel4.mp4',
    thumbnail_url: null,
    clips_count: 15,
    best_hole: { hole: 14, par: 4, score: 3, label: 'Birdie' },
  },
  {
    id: '5',
    course_name: 'Metropolitan',
    date: '2026-03-08',
    total_score: 71,
    total_par: 72,
    score_to_par: -1,
    total_putts: 28,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel5.mp4',
    thumbnail_url: null,
    clips_count: 11,
    best_hole: { hole: 18, par: 4, score: 2, label: 'Eagle' },
  },
  {
    id: '6',
    course_name: 'Peninsula Kingswood',
    date: '2026-03-01',
    total_score: 84,
    total_par: 72,
    score_to_par: 12,
    total_putts: 36,
    holes_played: 18,
    status: 'ready' as const,
    reel_url: 'https://example.com/reel6.mp4',
    thumbnail_url: null,
    clips_count: 18,
    best_hole: { hole: 5, par: 3, score: 3, label: 'Par' },
  },
  {
    id: '7',
    course_name: 'Woodlands',
    date: '2026-02-22',
    total_score: 77,
    total_par: 72,
    score_to_par: 5,
    total_putts: 31,
    holes_played: 18,
    status: 'processing' as const,
    reel_url: null,
    thumbnail_url: null,
    clips_count: 13,
    best_hole: { hole: 9, par: 5, score: 4, label: 'Birdie' },
  },
];

export type MockRound = (typeof MOCK_ROUNDS)[number];

export const MOCK_STATS = {
  roundsPlayed: MOCK_ROUNDS.length,
  bestScore: 71,
  avgScore: 78.1,
  totalBirdies: 8,
  totalEagles: 2,
  totalClips: MOCK_ROUNDS.reduce((sum, r) => sum + r.clips_count, 0),
  avgPutts: 31.9,
  coursesPlayed: 7,
};

// Gradient backgrounds for round cards (dark golf-themed)
export const CARD_GRADIENTS: [string, string][] = [
  ['#1a3a2a', '#0A0A0F'], // deep forest green
  ['#1a2a3a', '#0A0A0F'], // deep blue
  ['#2a1a2a', '#0A0A0F'], // deep purple
  ['#1a2a2a', '#0A0A0F'], // teal
  ['#2a2a1a', '#0A0A0F'], // olive
  ['#1a1a2a', '#0A0A0F'], // navy
  ['#2a1a1a', '#0A0A0F'], // maroon
];
