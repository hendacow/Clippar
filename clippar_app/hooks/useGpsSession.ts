import { useEffect, useRef, useState, useCallback } from 'react';
import { Platform, AppState, AppStateStatus } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import { gpsSession, type GpsHealth } from '@/lib/gpsSession';

/**
 * useGpsSession — Tracer V2 GPS backbone lifecycle (S3).
 *
 * Feeds the pure `gpsSession` ring from a continuous `watchPositionAsync`
 * (~1Hz, BestForNavigation) while the record tab is focused, replacing v1's
 * fatal one-shot `getCurrentPositionAsync` at recording stop. On blur it
 * downgrades to `Balanced` (keeps a coarse fix so the ring isn't stone-cold on
 * return) rather than stopping. On AppState resume it re-flags warm-up (the
 * first `warmupSec` of post-resume fixes are junk).
 *
 * Foreground / when-in-use only: no background modes, no Always permission —
 * the app is foregrounded all round for the camera + clicker anyway. The single
 * when-in-use prompt is requested here, at record-tab focus, well before any
 * recording (a surprise dialog mid-shot would wreck the capture).
 *
 * Returns the current `GpsHealth` for the record-screen chip (S5).
 */
export function useGpsSession(enabled: boolean): GpsHealth {
  const [health, setHealth] = useState<GpsHealth>({
    effAccM: null,
    state: 'locking',
    fixCount: 0,
  });
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const focusedRef = useRef(false);
  const lastLogRef = useRef(0);
  // Monotonic generation: every stopWatch/startWatch bumps it so an in-flight
  // start (awaiting permission / watchPositionAsync) can detect it was
  // superseded and tear its own subscription down instead of leaking it.
  const genRef = useRef(0);

  const isActive = enabled && Platform.OS !== 'web';

  const stopWatch = useCallback(() => {
    genRef.current++; // invalidate any start still awaiting
    try {
      subRef.current?.remove();
    } catch {
      /* subscription already gone */
    }
    subRef.current = null;
  }, []);

  const startWatch = useCallback(
    async (accuracy: Location.Accuracy) => {
      if (!isActive) return;
      // Only ever hold ONE subscription; restart cleanly on accuracy changes.
      stopWatch();
      const gen = genRef.current; // this start's generation
      try {
        // Non-prompting check first; request (the single when-in-use prompt)
        // only if not already granted. Foreground permission only.
        let granted = (await Location.getForegroundPermissionsAsync()).status === 'granted';
        if (!granted) {
          granted = (await Location.requestForegroundPermissionsAsync()).status === 'granted';
        }
        if (!granted || gen !== genRef.current) return; // superseded while awaiting

        const sub = await Location.watchPositionAsync(
          { accuracy, distanceInterval: 0, timeInterval: 1000 },
          (loc) => {
            gpsSession.addFix({
              ts: loc.timestamp,
              lat: loc.coords.latitude,
              lon: loc.coords.longitude,
              acc: loc.coords.accuracy ?? 999,
              // CoreLocation reports speed/heading as -1 when unknown; the
              // estimator treats speed<0 as "not stationary" (see isStationary).
              speed: loc.coords.speed ?? -1,
              course: loc.coords.heading ?? -1,
            });
            const now = Date.now();
            const h = gpsSession.currentEffAcc(now);
            setHealth(h);
            // [GPS-RING] structured log, throttled to ~1/s (dev builds only —
            // the whole hook is gated by `enabled` = variantIsDev()).
            if (now - lastLogRef.current >= 1000) {
              lastLogRef.current = now;
              console.log(
                '[GPS-RING]',
                JSON.stringify({
                  acc: Math.round((loc.coords.accuracy ?? 0) * 10) / 10,
                  spd: Math.round((loc.coords.speed ?? -1) * 10) / 10,
                  effAcc: h.effAccM == null ? null : Math.round(h.effAccM * 10) / 10,
                  state: h.state,
                  n: h.fixCount,
                })
              );
            }
          }
        );
        // A newer start/stop landed while we were awaiting — don't leak this one.
        if (gen !== genRef.current) {
          try {
            sub.remove();
          } catch {
            /* already gone */
          }
          return;
        }
        subRef.current = sub;
      } catch (err) {
        console.log('[useGpsSession] watch start failed (non-fatal):', err);
      }
    },
    [isActive, stopWatch]
  );

  // Focus → high-rate watch + warm-up; blur → downgrade to Balanced.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (isActive) {
        gpsSession.markWarmup(Date.now());
        void startWatch(Location.Accuracy.BestForNavigation);
      }
      return () => {
        focusedRef.current = false;
        if (isActive) void startWatch(Location.Accuracy.Balanced);
      };
    }, [isActive, startWatch])
  );

  // Re-warm-up on resume from background (GPS was suspended; early fixes drift).
  useEffect(() => {
    if (!isActive) return;
    const onChange = (next: AppStateStatus) => {
      if (next === 'active' && focusedRef.current) {
        gpsSession.markWarmup(Date.now());
        void startWatch(Location.Accuracy.BestForNavigation);
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [isActive, startWatch]);

  // Health ticks even without new fixes so 'locking' (stale/warm-up) surfaces.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setHealth(gpsSession.currentEffAcc(Date.now())), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Final teardown when the screen unmounts entirely.
  useEffect(() => stopWatch, [stopWatch]);

  return health;
}
