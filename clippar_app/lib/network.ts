/**
 * Connectivity check shared by flows that must not run offline (account
 * deletion needs to reach the Edge Function; the upload queue defers when
 * offline). Mirrors the conservative behaviour the upload queue relies on:
 * when NetInfo is unavailable or throws we assume ONLINE and let the actual
 * network call fail loudly, rather than blocking a user who is really online.
 */
export async function isConnected(): Promise<boolean> {
  let NetInfo: { fetch: () => Promise<{ isConnected?: boolean | null }> } | null =
    null;
  try {
    NetInfo = require('@react-native-community/netinfo').default;
  } catch {
    // Without NetInfo we can't tell — assume online.
    return true;
  }
  if (!NetInfo) return true;
  try {
    const state = await NetInfo.fetch();
    return state?.isConnected !== false;
  } catch {
    return true;
  }
}
