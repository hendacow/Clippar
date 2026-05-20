// Tiny pub-sub used to relay password-recovery deep links from the
// app-root URL listener (which runs at module load, before any screen
// mounts) into the reset-password screen (which mounts later).
//
// Without this, the reset-password screen's own Linking listener races
// the OS — expo-router delivers the URL event before useEffect can
// subscribe — so the screen never sees the URL at all.

import { supabase } from '@/lib/supabase';

export type RecoveryState =
  | { kind: 'pending' }
  | { kind: 'ready' }
  | { kind: 'invalid'; message: string };

let current: RecoveryState = { kind: 'pending' };
const listeners = new Set<(s: RecoveryState) => void>();

export function getRecoveryState(): RecoveryState {
  return current;
}

export function subscribeRecovery(cb: (s: RecoveryState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function set(next: RecoveryState) {
  current = next;
  for (const l of listeners) l(next);
}

// Resets the bus back to 'pending' so a fresh reset attempt can land
// cleanly. Called by the reset-password screen on unmount.
export function resetRecoveryBus() {
  current = { kind: 'pending' };
}

// Parse a deep-link URL and, if it carries a Supabase recovery payload,
// seed the session or surface the error. Idempotent — re-running on the
// same URL is harmless. Called from app/_layout.tsx's url listeners.
export async function consumeRecoveryDeepLink(url: string | null): Promise<void> {
  if (!url) return;

  // 1) PKCE flow: ?code=<auth_code>
  const qIdx = url.indexOf('?');
  if (qIdx !== -1) {
    const hashIdx = url.indexOf('#', qIdx);
    const qStr = hashIdx === -1 ? url.slice(qIdx + 1) : url.slice(qIdx + 1, hashIdx);
    const qp = new URLSearchParams(qStr);
    const code = qp.get('code');
    if (code) {
      console.log('[recoveryBus] PKCE code present, exchanging…');
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.log('[recoveryBus] exchangeCodeForSession error=', error.message);
        set({ kind: 'invalid', message: error.message });
      } else {
        console.log('[recoveryBus] session established via PKCE');
        set({ kind: 'ready' });
      }
      return;
    }
    if (qp.get('error') || qp.get('error_code')) {
      console.log('[recoveryBus] query error_code=', qp.get('error_code'));
      set({
        kind: 'invalid',
        message: qp.get('error_description') ?? 'This reset link is no longer valid.',
      });
      return;
    }
  }

  // 2) Implicit flow OR error redirect — both use the URL fragment
  const hIdx = url.indexOf('#');
  if (hIdx !== -1) {
    const hp = new URLSearchParams(url.slice(hIdx + 1));
    const type = hp.get('type');
    const access = hp.get('access_token');
    const refresh = hp.get('refresh_token');
    if (type === 'recovery' && access && refresh) {
      console.log('[recoveryBus] implicit recovery tokens present, setting session…');
      const { error } = await supabase.auth.setSession({
        access_token: access,
        refresh_token: refresh,
      });
      if (error) {
        console.log('[recoveryBus] setSession error=', error.message);
        set({ kind: 'invalid', message: error.message });
      } else {
        console.log('[recoveryBus] session established via implicit');
        set({ kind: 'ready' });
      }
      return;
    }
    if (hp.get('error') || hp.get('error_code')) {
      console.log(
        '[recoveryBus] hash error_code=',
        hp.get('error_code'),
        'desc=',
        hp.get('error_description')
      );
      // Decode +-encoding from URL form (Supabase uses + for spaces here).
      const raw = hp.get('error_description') ?? 'This reset link is no longer valid.';
      const desc = raw.replace(/\+/g, ' ');
      set({ kind: 'invalid', message: desc });
      return;
    }
  }

  // No recognized recovery payload — silently ignore. Other parts of the
  // app may handle this URL (auth-callback, future deep-link types).
}
