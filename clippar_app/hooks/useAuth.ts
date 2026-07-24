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

// Required so the browser-based Google OAuth flow completes cleanly when the
// system browser hands control back to the app. No-op when not in an auth
// session. Must run at module load — putting it inside the hook is too late.
WebBrowser.maybeCompleteAuthSession();

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
        // Nothing to alias; RevenueCat keeps its anonymous id until next login.
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

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: displayName },
      },
    });
    if (error) throw error;
  }, []);

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

    const hashIndex = result.url.indexOf('#');
    if (hashIndex === -1) throw new Error('No tokens in OAuth callback URL');
    const params = new URLSearchParams(result.url.substring(hashIndex + 1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) {
      throw new Error('OAuth callback missing tokens');
    }
    const { error: sessionErr } = await supabase.auth.setSession({ access_token, refresh_token });
    if (sessionErr) throw sessionErr;
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
