import { Stack } from 'expo-router';

// Cold-start sales funnel group — no header, full-bleed screens.
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />;
}
