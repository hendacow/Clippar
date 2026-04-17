import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import type { ReactNode } from 'react';
import { getSetting, setSetting } from '@/lib/storage';

/**
 * OnboardingContext
 * ------------------
 * Tracks first-run intro completion and an active "spotlight tour" step.
 *
 * Persistence keys (stored via lib/storage.ts key-value API):
 *   - onboarding.intro_done  -> '1' once the intro slides are finished/skipped
 *   - onboarding.tour_done   -> '1' once the spotlight tour is finished/skipped
 *
 * The context also exposes `registerTarget` / `unregisterTarget` so that
 * UI elements can report their on-screen rectangle via useOnboardingTarget.
 */

export type TourStepId =
  | 'record-button'
  | 'import-card'
  | 'rounds-list'
  | 'editor-auto-trim'
  | 'editor-export';

export const TOUR_STEPS: TourStepId[] = [
  'record-button',
  'import-card',
  'rounds-list',
  'editor-auto-trim',
  'editor-export',
];

export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TourStepCopy {
  title: string;
  body: string;
}

export const TOUR_COPY: Record<TourStepId, TourStepCopy> = {
  'record-button': {
    title: 'Tap here to start a round',
    body: 'This big red button kicks off recording. Hit it at the tee and we capture every shot.',
  },
  'import-card': {
    title: 'Already filmed it?',
    body: 'Drop in clips from your camera roll and we\'ll stitch them into a round just the same.',
  },
  'rounds-list': {
    title: 'Your rounds live here',
    body: 'Every round you record or import shows up in this library. Tap one to open the editor.',
  },
  'editor-auto-trim': {
    title: 'Auto-trim is on by default',
    body: 'We analyse each clip on-device and keep just the swing. Flip it off for full-length clips.',
  },
  'editor-export': {
    title: 'Share your highlight reel',
    body: 'Tap Export to render a PGA-worthy cut and share it straight to your group chat.',
  },
};

interface Flags {
  introDone: boolean;
  tourDone: boolean;
  loaded: boolean;
}

interface OnboardingContextType {
  flags: Flags;
  tourStepIndex: number | null;
  tourStepId: TourStepId | null;
  isStepActive: (id: TourStepId) => boolean;
  completeIntro: () => Promise<void>;
  skipIntro: () => Promise<void>;
  startTour: () => void;
  nextStep: () => void;
  endTour: (markDone?: boolean) => Promise<void>;
  replayOnboarding: () => Promise<void>;
  targets: Record<string, TargetRect | undefined>;
  registerTarget: (id: TourStepId, rect: TargetRect) => void;
  unregisterTarget: (id: TourStepId) => void;
}

const DEFAULT: OnboardingContextType = {
  flags: { introDone: true, tourDone: true, loaded: false },
  tourStepIndex: null,
  tourStepId: null,
  isStepActive: () => false,
  completeIntro: async () => {},
  skipIntro: async () => {},
  startTour: () => {},
  nextStep: () => {},
  endTour: async () => {},
  replayOnboarding: async () => {},
  targets: {},
  registerTarget: () => {},
  unregisterTarget: () => {},
};

const OnboardingContext = createContext<OnboardingContextType>(DEFAULT);

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<Flags>({
    introDone: true,
    tourDone: true,
    loaded: false,
  });
  const [tourStepIndex, setTourStepIndex] = useState<number | null>(null);
  const [targets, setTargets] = useState<Record<string, TargetRect | undefined>>({});
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  // Load flags on mount
  useEffect(() => {
    (async () => {
      try {
        const [intro, tour] = await Promise.all([
          getSetting('onboarding.intro_done'),
          getSetting('onboarding.tour_done'),
        ]);
        setFlags({
          introDone: intro === '1',
          tourDone: tour === '1',
          loaded: true,
        });
      } catch {
        // If storage fails (e.g., web stub), treat as first-run only if load fails
        setFlags({ introDone: false, tourDone: false, loaded: true });
      }
    })();
  }, []);

  const completeIntro = useCallback(async () => {
    try {
      await setSetting('onboarding.intro_done', '1');
    } catch {}
    setFlags((f) => ({ ...f, introDone: true }));
  }, []);

  const skipIntro = useCallback(async () => {
    try {
      await setSetting('onboarding.intro_done', '1');
      await setSetting('onboarding.tour_done', '1');
    } catch {}
    setFlags((f) => ({ ...f, introDone: true, tourDone: true }));
  }, []);

  const startTour = useCallback(() => {
    setTourStepIndex(0);
  }, []);

  const endTour = useCallback(async (markDone: boolean = true) => {
    setTourStepIndex(null);
    if (markDone) {
      try {
        await setSetting('onboarding.tour_done', '1');
      } catch {}
      setFlags((f) => ({ ...f, tourDone: true }));
    }
  }, []);

  const nextStep = useCallback(() => {
    setTourStepIndex((prev) => {
      if (prev === null) return null;
      const next = prev + 1;
      if (next >= TOUR_STEPS.length) {
        // Finished — mark tour done
        (async () => {
          try {
            await setSetting('onboarding.tour_done', '1');
          } catch {}
        })();
        setFlags((f) => ({ ...f, tourDone: true }));
        return null;
      }
      return next;
    });
  }, []);

  const replayOnboarding = useCallback(async () => {
    try {
      await setSetting('onboarding.intro_done', null);
      await setSetting('onboarding.tour_done', null);
    } catch {}
    setFlags({ introDone: false, tourDone: false, loaded: true });
    setTourStepIndex(null);
  }, []);

  const registerTarget = useCallback((id: TourStepId, rect: TargetRect) => {
    setTargets((prev) => {
      const existing = prev[id];
      if (
        existing &&
        existing.x === rect.x &&
        existing.y === rect.y &&
        existing.width === rect.width &&
        existing.height === rect.height
      ) {
        return prev;
      }
      return { ...prev, [id]: rect };
    });
  }, []);

  const unregisterTarget = useCallback((id: TourStepId) => {
    setTargets((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const tourStepId: TourStepId | null =
    tourStepIndex !== null ? (TOUR_STEPS[tourStepIndex] ?? null) : null;

  const isStepActive = useCallback(
    (id: TourStepId) => tourStepId === id,
    [tourStepId]
  );

  const value = useMemo<OnboardingContextType>(
    () => ({
      flags,
      tourStepIndex,
      tourStepId,
      isStepActive,
      completeIntro,
      skipIntro,
      startTour,
      nextStep,
      endTour,
      replayOnboarding,
      targets,
      registerTarget,
      unregisterTarget,
    }),
    [
      flags,
      tourStepIndex,
      tourStepId,
      isStepActive,
      completeIntro,
      skipIntro,
      startTour,
      nextStep,
      endTour,
      replayOnboarding,
      targets,
      registerTarget,
      unregisterTarget,
    ]
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}
