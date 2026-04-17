import { useOnboarding } from '@/contexts/OnboardingContext';
import { OnboardingIntro } from './OnboardingIntro';
import { SpotlightTour } from './SpotlightTour';

/**
 * OnboardingHost
 * --------------
 * Mounts the intro modal + spotlight tour. Reads flags from OnboardingContext
 * and drives transitions between them (intro -> tour).
 *
 * Intentionally lives above the app's Stack so overlays render over any screen.
 */
export function OnboardingHost() {
  const { flags, completeIntro, skipIntro, startTour } = useOnboarding();

  const introVisible = flags.loaded && !flags.introDone;

  return (
    <>
      <OnboardingIntro
        visible={introVisible}
        onComplete={async () => {
          await completeIntro();
          // After the intro, launch the spotlight tour if not previously done.
          if (!flags.tourDone) {
            // Small delay so the intro modal finishes its fade before the
            // spotlight modal mounts.
            setTimeout(() => startTour(), 300);
          }
        }}
        onSkip={async () => {
          await skipIntro();
        }}
      />
      <SpotlightTour />
    </>
  );
}
