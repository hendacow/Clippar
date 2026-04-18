import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
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
  const queuedTourStart = useRef(false);

  // Watch for intro finishing and tour not being done — drive the handoff
  // here instead of a flaky 300ms setTimeout chained off the intro's onComplete.
  // The prior setTimeout sometimes fired before Home's spotlight targets had
  // re-registered, so the first spotlight showed with a missing target rect.
  useEffect(() => {
    if (!flags.loaded) return;
    if (!flags.introDone) return;
    if (flags.tourDone) return;
    if (queuedTourStart.current) return;

    queuedTourStart.current = true;
    // Home tab hosts the first three spotlight targets — make sure we're
    // there before flipping the tour on.
    try { router.replace('/(tabs)'); } catch {}
    // Give Home a frame to mount + register targets, then a second rAF so
    // the intro's fade-out has flushed.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        startTour();
      });
    });
  }, [flags.loaded, flags.introDone, flags.tourDone, startTour]);

  return (
    <>
      <OnboardingIntro
        visible={introVisible}
        onComplete={async () => {
          await completeIntro();
          // Tour auto-start is driven by the useEffect above.
        }}
        onSkip={async () => {
          await skipIntro();
        }}
      />
      <SpotlightTour />
    </>
  );
}
