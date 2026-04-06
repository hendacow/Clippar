export const theme = {
  colors: {
    // Backgrounds
    background: '#0A0A0F',
    surface: '#12121A',
    surfaceElevated: '#1A1A28',
    surfaceBorder: '#2A2A3A',

    // Brand
    primary: '#4CAF50',
    primaryLight: '#81C784',
    primaryDark: '#388E3C',
    primaryMuted: 'rgba(76, 175, 80, 0.15)',

    // Accent
    accent: '#A8E63D',
    accentGold: '#FFD700',
    accentRed: '#FF4444',
    accentBlue: '#2196F3',

    // Text
    textPrimary: '#FFFFFF',
    textSecondary: '#9E9EB8',
    textTertiary: '#5A5A72',

    // Status
    recording: '#FF3B30',
    connected: '#4CAF50',
    disconnected: '#FF4444',
    processing: '#FF9800',
    ready: '#4CAF50',

    // Scoring
    eagle: '#FFD700',
    birdie: '#4CAF50',
    par: '#FFFFFF',
    bogey: '#FF9800',
    doubleBogey: '#FF4444',
  },

  spacing: {
    xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48,
  },

  radius: {
    sm: 8, md: 12, lg: 16, xl: 24, full: 9999,
  },

  typography: {
    h1: { fontSize: 32, fontWeight: '800' as const, letterSpacing: -0.5 },
    h2: { fontSize: 24, fontWeight: '700' as const, letterSpacing: -0.3 },
    h3: { fontSize: 20, fontWeight: '600' as const },
    body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
    bodySmall: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
    caption: { fontSize: 12, fontWeight: '500' as const, letterSpacing: 0.5 },
    score: { fontSize: 48, fontWeight: '900' as const, letterSpacing: -1 },
    hole: { fontSize: 64, fontWeight: '900' as const, letterSpacing: -2 },
  },

  shadows: {
    card: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
    glow: {
      shadowColor: '#4CAF50',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 20,
      elevation: 10,
    },
  },
} as const;

export type Theme = typeof theme;
