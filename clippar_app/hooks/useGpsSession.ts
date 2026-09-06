import { useEffect, useRef, useState, useCallback } from 'react';
import { Platform, AppState, AppStateStatus } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import { config } from '@/constants/config';
import { gpsSession, type GpsHealth } from '@/lib/gpsSession';

/**
 * useGpsSession — the tracer's GPS lifecycle.
 *
 * Feeds the pure `gpsSession` ring from a continuous `watchPositionAsync`
 * (~1 Hz, BestForNavigation) while the record tab is focused, replacing v1's
 * fatal one-shot `getCurrentPositionAsync` at recording stop — which came back
 * with a cached, WiFi-anchored fix and collapsed the carry to ~0. On blur it
 * downgrades to `Balanced` (keeps a coarse fix so the ring isn't stone-cold on
 * return) rather than stopping. On AppState resume it re-flags warm-up, because
 * GPS was suspended and the first fixes back are junk.
 *
 * FOREGROUND / WHEN-IN-USE ONLY. No background modes, no Always permission, no
 * `startLocationUpdatesAsync` — the app is foregrounded all round for the camera
 * and the clicker anyway, so nothing here needs to survive backgrounding, and
 * an Always prompt is both unnecessary and a review liability.
 *
 * Ported from `origin/tracer-v2:clippar_app/hooks/useGpsSession.ts`. V3 changes
 * are marked inline: the master-kill-switch check, and the honest `denied` /
 * `off` health states in place of a permanent, lying `locking`.
 *
 * Returns the current `GpsHealth` for the dev-settings / record-screen chip.
 */
export function useGpsSession(enabled: boolean): GpsHealth {
  /**
   * V3 CHANGE — the caller's `enabled` is ANDed with the master kill switch
   * rather than trusted on its own. `config.tracer.enabled` is false for
   * preview and production, and the product requirement is that the app is
   * byte-identical with the tracer off: no GPS session, and above all NO
   * PERMISSION PROMPT. A caller that passes `true` by mistake would otherwise
   * put a location dialog in front of a production user. Defence in depth is
   * warranted for the one side effect here that the user actually sees.
   */
  const isActive = enabled && config.tracer.enabled && Platform.OS !== 'web';

  const [health, setHealth] = useState<GpsHealth>({
    effAccM: null,
    state: isActive ? 'locking' : 'off',
    fixCount: 0,
  });
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const focusedRef = useRef(false);
  const lastLogRef = useRef(0);
  // Monotonic generation: every stopWatch/startWatch bumps it so an in-flight
  // start (awaiting permission / watchPositionAsync) can detect it was
  // superseded and tear its own subscription down instead of leaking it.
  const genRef = useRef(0);
  /**
   * V3 CHANGE — sticky "the user said no". Without it the 1 Hz health tick
   * below would immediately overwrite the `denied` state with `locking`, and
   * the chip would sit there implying a fix is coming when none ever will.
   * Cleared the moment permission is actually granted (the user can change it
   * in Settings mid-round).
   */
  const deniedRef = useRef(false);

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
        const current = await Location.getForegroundPermissionsAsync();
        let granted = current.status === 'granted';
        if (!granted && current.canAskAgain === false) {
          // The OS will not show the dialog again — asking is a guaranteed
          // no-op, so record the refusal instead of round-tripping for it.
          deniedRef.current = true;
          setHealth({ effAccM: null, state: 'denied', fixCount: 0 });
          return;
        }
        if (!granted) {
          granted = (await Location.requestForegroundPermissionsAsync()).status === 'granted';
        }
        if (!granted) {
          // V3 CHANGE — degrade, loudly but harmlessly. Everything downstream
          // reads the ring, which simply stays empty, so `estimateShotFix`
          // returns null and the tracer skips. No throw, no retry loop.
          deniedRef.current = true;
          setHealth({ effAccM: null, state: 'denied', fixCount: 0 });
          return;
        }
        deniedRef.current = false;
        if (gen !== genRef.current) return; // superseded while awaiting

        const sub = await Location.watchPositionAsync(
          { accuracy, distanceInterval: 0, timeInterval: 1000 },
          (loc) => {
            gpsSession.addFix({
              ts: loc.timestamp,
              lat: loc.coords.latitude,
              lon: loc.coords.longitude,
              acc: loc.coords.accuracy ?? 999,
              // CoreLocation reports speed/heading as -1 when unknown; the
              // estimator treats speed<0 as "not stationary" (see isStationary)
              // and as a movement barrier at the impact anchor.
              speed: loc.coords.speed ?? -1,
              course: loc.coords.heading ?? -1,
            });
            const now = Date.now();
            const h = gpsSession.currentEffAcc(now);
            setHealth(h);
            // [GPS-RING] structured log, throttled to ~1/s. Dev builds only —
            // the whole hook is gated on config.tracer.enabled, which is false
            // everywhere but the development variant.
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
        // Never throw out of the hook: a location failure must degrade the
        // tracer, not break the record screen.
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
        // Only re-arm warm-up when the ring is actually cold. Re-warming on
        // every tab focus would throw away a warm minute of fixes (tab away →
        // back → record within 8 s used to read gps-stale).
        if (gpsSession.isCold(Date.now())) gpsSession.markWarmup(Date.now());
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
    const id = setInterval(() => {
      if (deniedRef.current) return; // don't overwrite a refusal with 'locking'
      setHealth(gpsSession.currentEffAcc(Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Final teardown when the screen unmounts entirely.
  useEffect(() => stopWatch, [stopWatch]);

  return health;
}
