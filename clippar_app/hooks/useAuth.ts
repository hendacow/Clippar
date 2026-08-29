import { useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { Session, User } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as AppleAuthentication from 'expo-apple-authentication';
import { supabase } from '@/lib/supabase';
import { iap } from '@/lib/iap';
import { linkAppleCredentials } from '@/lib/api';
import { isInvalidRefreshTokenError } from '@/lib/authSessionLogic';
import { clearRoundPrefetch } from '@/lib/roundPrefetch';

// Required so the browser-based Google OAuth flow completes cleanly when the
// system browser hands control back to the app. No-op when not in an auth
// session. Must run at module load — putting it inside the hook is too late.
WebBrowser.maybeCompleteAuthSession();

/**
 * Detach this device's third-party account state when a session ends.
 *
 * Only RevenueCat, deliberately. `iap.reset()` has existed since the IAP work
 * and is documented "on sign-out / deletion", but nothing ever called it: the
 * SDK keeps the previously identified appUserID and its cached CustomerInfo
 * after Supabase signs out, so `isProActive()` can answer from the departed
 * account's cache in the window before the next `logIn()` finishes its native
 * round-trip — and that answer gets written into the new account's Pro cache.
 *
 * What this deliberately does NOT do is wipe local data. The audit also flagged
 * that sign-out leaves the previous user's rounds in SQLite, which is true, but
 * this app stores a golfer's ONLY copy of their footage on the device. Clearing
 * it here would silently destroy a round that cannot be re-recorded, and a
 * shared handset is a far rarer situation than someone signing out and back in.
 * That one needs a considered fix (scope the local rows to a user id, offer an
 * explicit "remove local media" action) rather than a wipe bolted onto sign-out.
 *
 * Never throws: this runs inside the auth state listener, where an exception
 * would derail every other subscriber to the same event.
 */
async function resetLocalAccountState(): Promise<void> {
  // The in-memory round-detail prefetch holds the departing user's round
  // payloads (GPS + clip paths). Sessions also end HERE without ever passing
  // through finishSignOut()'s clearAccountLinkedCaches() — remote revoke,
  // refresh-token failure — so the cache must be scrubbed on the auth event
  // too, not just on the sign-out button.
  clearRoundPrefetch();
  try {
    await iap.reset();
  } catch {
    // A failed reset must not block sign-out. Worst case the SDK keeps a stale
    // customer until the next successful identify() overwrites it.
  }
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Cold-start session recovery. getSession() attempts a token refresh; when
    // the stored refresh token is stale/missing GoTrue rejects with an
    // "Invalid Refresh Token" AuthApiError. Without this try/catch that
    // rejection is uncaught and surfaces as a red LogBox error on device. We
    // handle ONLY that case by clearing the dead token and treating the user as
    // signed out — any other error is logged (not re-thrown, which would just be
    // a fresh red box) and a VALID session is never disturbed.
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);
        // Alias the RevenueCat customer to the Supabase user so StoreKit and
        // web subscriptions resolve to the same person. Fire-and-forget.
        if (session?.user) void iap.identify(session.user.id);
      } catch (err) {
        if (cancelled) return;
        if (isInvalidRefreshTokenError(err)) {
          // Stale token that can never be recovered — purge it locally (no
          // network call) and land cleanly on the login screen. onAuthStateChange
          // will also fire SIGNED_OUT; both paths converge on a null session.
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch {
            // Best-effort; a failed local sign-out must not resurface an error.
          }
          if (cancelled) return;
          setSession(null);
          setUser(null);
          setLoading(false);
        } else {
          // Not the stale-token case (e.g. transient/unknown error). Don't
          // clear a possibly-valid session and don't re-throw (that would be a
          // fresh uncaught rejection / red box). Log for dev visibility and let
          // onAuthStateChange's INITIAL_SESSION reconcile the real state.
          console.warn('[useAuth] getSession failed (non-token error):', err);
          setLoading(false);
        }
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED, SIGNED_IN, INITIAL_SESSION → carry the fresh session.
      // SIGNED_OUT (including the local sign-out above) → session is null, which
      // routes the user to login. In all cases mirror GoTrue's own state rather
      // than second-guess it.
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (event === 'SIGNED_OUT') {
        // RevenueCat does NOT fall back to an anonymous id on its own — it
        // keeps the previously identified user's appUserID and their cached
        // CustomerInfo. Without logOut(), the next account to sign in on this
        // handset can read the previous account's entitlement (isProActive
        // answers from the stale cache before logIn(B) finishes its native
        // round-trip) and have it written into their own Pro cache. Reset here
        // as well as in signOut() below, because a session can also end without
        // going through our button (remote revoke, refresh-token failure).
        void resetLocalAccountState();
        return;
      }
      if (session?.user) void iap.identify(session.user.id);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  /**
   * Create an account.
   *
   * Returns whether the caller must still send the user to a "check your
   * email" screen. Supabase decides that, not us: when the project requires
   * email confirmation it returns a user with NO session, and when it does not
   * it signs the account straight in and returns one.
   *
   * This used to discard `data` entirely, so the signup screen had no way to
   * tell the two apart and showed "Check Your Email" every time. With
   * confirmation off (2026-08-05) that stranded every new user on a dead end
   * telling them to click a link that would never be sent, while their account
   * existed and was already signed in.
   */
  const signUp = useCallback(
    async (
      email: string,
      password: string,
      displayName?: string
    ): Promise<{ needsEmailConfirmation: boolean }> => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: displayName },
        },
      });
      if (error) throw error;
      return { needsEmailConfirmation: !data.session };
    },
    []
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  // Sends a password-reset email via Supabase. The email link redirects the
  // user back into the app at `<scheme>://reset-password` with a recovery
  // session in the URL fragment; the reset-password screen picks it up and
  // calls updateUser({ password }) to finish.
  const resetPassword = useCallback(async (email: string) => {
    const redirectTo = Linking.createURL('reset-password');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }, []);

  // Browser-based Google OAuth via Supabase's hosted callback. We use
  // signInWithOAuth with skipBrowserRedirect to get the URL ourselves, hand
  // it to expo-web-browser, and pull the access/refresh tokens out of the
  // returned URL fragment to seed the local Supabase session.
  const signInWithGoogle = useCallback(async () => {
    const redirectTo = Linking.createURL('auth-callback');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data?.url) throw new Error('No OAuth URL returned by Supabase');

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') {
      // User dismissed the browser sheet — soft-cancel signal that callers
      // can recognize and swallow without showing an error toast.
      throw new Error('cancelled');
    }

    // PKCE (lib/supabase.ts `flowType`): the callback carries a single-use
    // `code` in the QUERY string, not tokens in the fragment. We deliberately
    // do NOT read `#access_token`/`#refresh_token` any more — that shape meant
    // anything able to receive the redirect (a stale allowlist entry, another
    // app claiming `clippar://`) walked away with a long-lived refresh token.
    // exchangeCodeForSession pairs the code with the verifier this device
    // stored when it built the authorize URL, so an intercepted code is inert.
    const queryStart = result.url.indexOf('?');
    const query = queryStart === -1 ? '' : result.url.substring(queryStart + 1);
    const params = new URLSearchParams(query.split('#')[0]);
    const oauthError = params.get('error_description') ?? params.get('error');
    if (oauthError) throw new Error(oauthError);
    const code = params.get('code');
    if (!code) throw new Error('OAuth callback missing authorization code');

    const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeErr) throw exchangeErr;
  }, []);

  // Native Apple Sign-In on iOS. Apple returns an identity token (JWT) that
  // Supabase verifies server-side. App Store Guideline 4.8 requires this be
  // present whenever any other third-party login (Google, etc.) is offered.
  const signInWithApple = useCallback(async () => {
    if (Platform.OS !== 'ios') {
      throw new Error('Apple Sign-In is iOS only');
    }
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) {
      throw new Error('No identity token from Apple');
    }
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
    });
    if (error) throw error;

    // Capture the Apple refresh token so we can revoke it on account deletion
    // (App Store 5.1.1(v)). The authorization code is one-time and only present
    // here — hand it to the server fire-and-forget; never block sign-in on it.
    if (credential.authorizationCode) {
      void linkAppleCredentials(
        credential.authorizationCode,
        credential.identityToken
      );
    }
  }, []);

  return {
    session,
    user,
    loading,
    signIn,
    signUp,
    signOut,
    resetPassword,
    signInWithGoogle,
    signInWithApple,
  };
}
