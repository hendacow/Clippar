/**
 * Web stubs for biometrics — native-only modules unavailable on web.
 */

export async function isBiometricAvailable(): Promise<boolean> {
  return false;
}

export async function authenticateWithBiometrics(): Promise<boolean> {
  return true;
}

export async function getBiometricPreference(): Promise<boolean> {
  return false;
}

export async function setBiometricPreference(_enabled: boolean): Promise<void> {}
