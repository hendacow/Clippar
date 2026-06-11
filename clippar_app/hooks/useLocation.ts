import { useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

interface Coordinates {
  latitude: number;
  longitude: number;
  /**
   * Horizontal accuracy radius in meters (null when the platform omits it).
   * Additive — existing callers that only read lat/lng are unaffected. The
   * shot tracer uses it to gate landing-spot pairing on GPS quality.
   */
  accuracy?: number | null;
}

/** Compass fix captured at record start (camera optical-axis azimuth). */
export interface HeadingFix {
  headingDeg: number;
  /** False = magnetic fallback (trueHeading unavailable) — unflagged magnetic
   *  declination would skew bearings by ~0-15°, so consumers must know. */
  isTrue: boolean;
  /** iOS calibration level 0-3 (3 = <20° uncertainty). */
  calibration: number;
}

/**
 * Force a GENUINELY FRESH GPS fix.
 *
 * `getCurrentPositionAsync` can return a cached CLLocation — observed in the
 * field as byte-identical coords across shots taken ~80m apart (it coasted on
 * a WiFi-anchored last-known position through a WiFi→4G handoff). A stale fix
 * collapses the tracer's carry distance to ~0 and silently skips the arc.
 *
 * We briefly `watchPositionAsync` and accept only a fix whose `timestamp` is
 * at/after this call (Core Location delivers the stale last-known fix first,
 * which we reject by its old timestamp), then take the first fresh one. Hard
 * timeout so a cold/indoor GPS can never hang the clip save.
 */
async function getFreshFix(timeoutMs = 6000): Promise<Coordinates | null> {
  const t0 = Date.now();
  return new Promise<Coordinates | null>((resolve) => {
    let sub: Location.LocationSubscription | null = null;
    let done = false;
    const finish = (c: Coordinates | null) => {
      if (done) return;
      done = true;
      try { sub?.remove(); } catch {}
      resolve(c);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 0,
        timeInterval: 500,
      },
      (loc) => {
        // 2s slack for clock skew; the cached fix is stamped tens of seconds
        // (or minutes) old, so it never passes this gate.
        if (loc.timestamp >= t0 - 2000) {
          clearTimeout(timer);
          finish({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? null,
          });
        }
      }
    )
      .then((s) => {
        sub = s;
        if (done) { try { s.remove(); } catch {} }
      })
      .catch(() => finish(null));
  });
}

export function useLocation() {
  const [hasPermission, setHasPermission] = useState(false);
  const [lastLocation, setLastLocation] = useState<Coordinates | null>(null);

  const requestPermission = useCallback(async () => {
    if (Platform.OS === 'web') {
      setHasPermission(false);
      return false;
    }

    const { status } = await Location.requestForegroundPermissionsAsync();
    const granted = status === 'granted';
    setHasPermission(granted);
    return granted;
  }, []);

  const getCurrentLocation = useCallback(
    async (opts?: { highAccuracy?: boolean }): Promise<Coordinates | null> => {
      if (Platform.OS === 'web') return null;
      if (!hasPermission) {
        const granted = await requestPermission();
        if (!granted) return null;
      }

      try {
        // Tracer (highAccuracy): demand a fresh fix so an 80m walk actually
        // registers as an 80m carry. Falls through to the standard one-shot if
        // the watch times out (cold GPS) — never worse than today's behavior.
        if (opts?.highAccuracy) {
          const fresh = await getFreshFix();
          if (fresh) {
            setLastLocation(fresh);
            return fresh;
          }
        }
        const location = await Location.getCurrentPositionAsync({
          // BestForNavigation only when the caller needs a tight accuracy
          // radius (tracer landing-spot pairing); High otherwise — identical
          // to the pre-tracer behavior when opts is omitted.
          accuracy: opts?.highAccuracy
            ? Location.Accuracy.BestForNavigation
            : Location.Accuracy.High,
        });
        const coords = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracy: location.coords.accuracy ?? null,
        };
        setLastLocation(coords);
        return coords;
      } catch {
        return null;
      }
    },
    [hasPermission, requestPermission]
  );

  /**
   * One-shot compass heading. CLLocationManager.headingOrientation defaults
   * to .portrait, so for the portrait tripod-mounted phone this IS the
   * back-camera optical-axis azimuth — no correction needed. NEVER use
   * coords.heading from getCurrentPositionAsync (that's course-over-ground,
   * garbage on a stationary tripod).
   *
   * F13: this fires at recording start, where a surprise permission dialog
   * would wreck the shot — so the permission check is the NON-prompting
   * getForegroundPermissionsAsync. Not already granted → null, never prompt.
   */
  const getCurrentHeading = useCallback(async (): Promise<HeadingFix | null> => {
    if (Platform.OS === 'web') return null;
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return null;
      const h = await Location.getHeadingAsync();
      // trueHeading silently reports -1 when unavailable; fall back to
      // magnetic and flag it so geometry can account for declination skew.
      const isTrue = h.trueHeading >= 0;
      return {
        headingDeg: isTrue ? h.trueHeading : h.magHeading,
        isTrue,
        calibration: h.accuracy,
      };
    } catch {
      return null;
    }
  }, []);

  return {
    hasPermission,
    lastLocation,
    requestPermission,
    getCurrentLocation,
    getCurrentHeading,
  };
}
