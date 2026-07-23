import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useAuth } from '@/hooks/useAuth';
import { SpotlightTour } from './SpotlightTour';

/**
 * OnboardingHost
 * --------------
 * Mounts the signed-in Home spotlight tour. Reads flags from
 * OnboardingContext and starts the tour once the intro flag settles.
 *
 * Intentionally lives above the app's Stack so overlays render over any screen.
 *
 * NOTE: the legacy first-run INTRO MODAL (OnboardingIntro, "Welcome to
 * Clippar", 4 slides) is RETIRED. Its welcome-pitch job belongs to the
 * 10-screen /(onboarding) sales funnel now — and because this host renders
 * ABOVE the router, the modal was covering that funnel on every fresh
 * install (found on the first cold-start simulator run). We auto-complete
 * the intro flag so the tour chain below keeps working unchanged.
 */
export function OnboardingHost() {
  const { flags, completeIntro, startTour } = useOnboarding();
  const { user } = useAuth();

  const queuedTourStart = useRef(false);

  // Retire the legacy intro: mark it done as soon as flags load so it can
  // never gate (or cover) anything again. Existing users who already
  // completed it are unaffected; new users get the funnel instead.
  useEffect(() => {
    if (flags.loaded && !flags.introDone) {
      completeIntro().catch(() => {});
    }
  }, [flags.loaded, flags.introDone, completeIntro]);

  // Watch for intro finishing and tour not being done — drive the handoff
  // here instead of a flaky 300ms setTimeout chained off the intro's onComplete.
  // The prior setTimeout sometimes fired before Home's spotlight targets had
  // re-registered, so the first spotlight showed with a missing target rect.
  useEffect(() => {
    if (!flags.loaded) return;
    if (!flags.introDone) return;
    if (flags.tourDone) return;
    // FIELD BUG: with no session, the auth gate bounces /(tabs) to the login
    // screen and all five spotlight steps rendered over the email form,
    // anchored to nothing. The tour only makes sense signed-in, on Home.
    if (!user) return;
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

  return <SpotlightTour />;
}
