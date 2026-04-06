import { useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

interface Coordinates {
  latitude: number;
  longitude: number;
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

  const getCurrentLocation = useCallback(async (): Promise<Coordinates | null> => {
    if (Platform.OS === 'web') return null;
    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) return null;
    }

    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };
      setLastLocation(coords);
      return coords;
    } catch {
      return null;
    }
  }, [hasPermission, requestPermission]);

  return { hasPermission, lastLocation, requestPermission, getCurrentLocation };
}
