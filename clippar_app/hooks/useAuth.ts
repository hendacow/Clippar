import { useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { Session, User } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as AppleAuthentication from 'expo-apple-authentication';
import { supabase } from '@/lib/supabase';
import { iap } from '@/lib/iap';

// Required so the browser-based Google OAuth flow completes cleanly when the
// system browser hands control back to the app. No-op when not in an auth
// session. Must run at module load — putting it inside the hook is too late.
WebBrowser.maybeCompleteAuthSession();

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      // Alias the RevenueCat customer to the Supabase user so StoreKit and
      // web subscriptions resolve to the same person. Fire-and-forget.
      if (session?.user) void iap.identify(session.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session?.user) void iap.identify(session.user.id);
    });

    return () => subscription.unsubscribe();
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
