import { useCallback, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import {
  useOnboarding,
  type TourStepId,
} from '@/contexts/OnboardingContext';

/**
 * useOnboardingTarget
 * -------------------
 * Returns a `ref` + `onLayout` handler pair. Attach both to any View/Pressable
 * that should be highlighted by the spotlight tour:
 *
 *   const { ref, onLayout } = useOnboardingTarget('record-button');
 *   <Pressable ref={ref} onLayout={onLayout} ... />
 *
 * When the component mounts and lays out, its absolute screen rect is reported
 * to the OnboardingContext so the SpotlightTour can draw the cutout + callout.
 */
export function useOnboardingTarget(id: TourStepId) {
  const { registerTarget, unregisterTarget } = useOnboarding();
  const ref = useRef<View | null>(null);

  const onLayout = useCallback(() => {
    const node = ref.current;
    if (!node || typeof node.measureInWindow !== 'function') return;
    // measureInWindow gives coordinates relative to the root window
    node.measureInWindow((x, y, width, height) => {
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      ) {
        registerTarget(id, { x, y, width, height });
      }
    });
  }, [id, registerTarget]);

  useEffect(() => {
    return () => unregisterTarget(id);
  }, [id, unregisterTarget]);

  return { ref, onLayout };
}
