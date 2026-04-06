/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: '#0A0A0F',
        surface: '#12121A',
        'surface-elevated': '#1A1A28',
        'surface-border': '#2A2A3A',
        primary: '#4CAF50',
        'primary-light': '#81C784',
        'primary-dark': '#388E3C',
        accent: '#A8E63D',
        'accent-gold': '#FFD700',
        'accent-red': '#FF4444',
        'accent-blue': '#2196F3',
        'text-primary': '#FFFFFF',
        'text-secondary': '#9E9EB8',
        'text-tertiary': '#5A5A72',
        recording: '#FF3B30',
      },
    },
  },
  plugins: [],
};
