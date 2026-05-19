import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';

// Handles both Supabase recovery callback flows on a single URL parse:
//   - PKCE  (default in supabase-js v2.x): `<scheme>://reset-password?code=...`
//     → call exchangeCodeForSession(code) to seed the recovery session.
//   - Implicit (older): `<scheme>://reset-password#access_token=...&refresh_token=...&type=recovery`
//     → call setSession({access, refresh}).
// Returns: 'ready' on success, 'invalid' if a recovery payload was present
// but couldn't be exchanged, or 'not-recovery' if the URL had no recovery
// payload at all (so the caller can keep waiting for the real link).
async function consumeRecoveryUrl(
  url: string | null
): Promise<'ready' | 'invalid' | 'not-recovery'> {
  if (!url) return 'not-recovery';

  // 1) PKCE: ?code=<auth_code>
  const qIdx = url.indexOf('?');
  if (qIdx !== -1) {
    const hashIdx = url.indexOf('#', qIdx);
    const qStr = hashIdx === -1 ? url.slice(qIdx + 1) : url.slice(qIdx + 1, hashIdx);
    const qp = new URLSearchParams(qStr);
    const code = qp.get('code');
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      return error ? 'invalid' : 'ready';
    }
    // Supabase sometimes redirects with an explicit error param when the
    // token is expired/used. Surface that as invalid so the user gets a
    // clear message.
    if (qp.get('error') || qp.get('error_code')) return 'invalid';
  }

  // 2) Implicit: #access_token=...&refresh_token=...&type=recovery
  const hIdx = url.indexOf('#');
  if (hIdx !== -1) {
    const hp = new URLSearchParams(url.slice(hIdx + 1));
    const type = hp.get('type');
    const access = hp.get('access_token');
    const refresh = hp.get('refresh_token');
    if (type === 'recovery' && access && refresh) {
      const { error } = await supabase.auth.setSession({
        access_token: access,
        refresh_token: refresh,
      });
      return error ? 'invalid' : 'ready';
    }
    if (hp.get('error') || hp.get('error_code')) return 'invalid';
  }

  return 'not-recovery';
}

export default function ResetPasswordScreen() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [linkReady, setLinkReady] = useState<'pending' | 'ready' | 'invalid'>('pending');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // We also track the resolved state in a ref so the deadline timeout can
  // read the latest value without re-creating the effect on every render
  // (React closures would otherwise capture the initial 'pending').
  const stateRef = useRef<'pending' | 'ready' | 'invalid'>('pending');

  useEffect(() => {
    let mounted = true;

    const resolve = (next: 'ready' | 'invalid', message?: string) => {
      if (!mounted || stateRef.current !== 'pending') return;
      stateRef.current = next;
      setLinkReady(next);
      if (message) setError(message);
    };

    const consume = async (url: string | null) => {
      const result = await consumeRecoveryUrl(url);
      if (result === 'ready') resolve('ready');
      else if (result === 'invalid') resolve('invalid', 'This reset link is no longer valid.');
      // 'not-recovery' → keep waiting; another url event may bring the real one.
    };

    // Listen for url events first — on a warm app launch the deep link
    // arrives via this event, not via getInitialURL.
    const sub = Linking.addEventListener('url', (e) => {
      consume(e.url);
    });

    // Then check the launch URL (cold-start path).
    Linking.getInitialURL().then((initial) => {
      if (mounted) consume(initial);
    });

    // Safety net: if no recovery URL has been seen within 5s, mark invalid
    // so the user isn't stuck on a blank screen. 5s is generous enough that
    // a slow deep-link handoff doesn't false-trip.
    const deadlineId = setTimeout(() => {
      if (mounted && stateRef.current === 'pending') resolve('invalid');
    }, 5000);

    return () => {
      mounted = false;
      sub.remove();
      clearTimeout(deadlineId);
    };
  }, []);

  const handleSubmit = async () => {
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;
      // Sign out so the recovery session doesn't linger; force a fresh login
      // with the new password. This also prevents the user from staying
      // logged in via a transient recovery token.
      await supabase.auth.signOut();
      setDone(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not update password';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <GradientBackground>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: theme.spacing.lg,
          }}
        >
          <Text style={{ ...theme.typography.h2, color: theme.colors.primary, marginBottom: 16 }}>
            Password updated
          </Text>
          <Text
            style={{
              ...theme.typography.body,
              color: theme.colors.textSecondary,
              textAlign: 'center',
              marginBottom: 32,
            }}
          >
            You can now sign in with your new password.
          </Text>
          <Button title="Sign in" onPress={() => router.replace('/(auth)/login')} />
        </View>
      </GradientBackground>
    );
  }

  if (linkReady === 'invalid') {
    return (
      <GradientBackground>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: theme.spacing.lg,
          }}
        >
          <Text style={{ ...theme.typography.h2, color: theme.colors.accentRed, marginBottom: 16 }}>
            Link invalid or expired
          </Text>
          <Text
            style={{
              ...theme.typography.body,
              color: theme.colors.textSecondary,
              textAlign: 'center',
              marginBottom: 32,
            }}
          >
            This reset link can no longer be used. Request a new one from the login screen.
          </Text>
          <Button
            title="Back to login"
            onPress={() => router.replace('/(auth)/login')}
            variant="secondary"
          />
        </View>
      </GradientBackground>
    );
  }

  if (linkReady === 'pending') {
    // Short, deliberate blank state while we resolve the deep link. Avoids
    // flashing the form before the session is set up.
    return <GradientBackground><View style={{ flex: 1 }} /></GradientBackground>;
  }

  return (
    <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            padding: theme.spacing.lg,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Text
              style={{
                ...theme.typography.h1,
                color: theme.colors.textPrimary,
                fontSize: 28,
                letterSpacing: -0.5,
              }}
            >
              Set a new password
            </Text>
            <Text
              style={{
                ...theme.typography.bodySmall,
                color: theme.colors.textSecondary,
                marginTop: 8,
              }}
            >
              At least 6 characters.
            </Text>
          </View>

          <View style={{ gap: 16 }}>
            <View>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  fontWeight: '500',
                  marginBottom: 6,
                  marginLeft: 4,
                }}
              >
                New password
              </Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Min 6 characters"
                placeholderTextColor={theme.colors.textTertiary}
                secureTextEntry
                autoComplete="new-password"
                style={{
                  backgroundColor: theme.colors.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  borderRadius: theme.radius.md,
                  padding: 14,
                  color: theme.colors.textPrimary,
                  fontSize: 16,
                }}
              />
            </View>

            <View>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 13,
                  fontWeight: '500',
                  marginBottom: 6,
                  marginLeft: 4,
                }}
              >
                Confirm new password
              </Text>
              <TextInput
                value={confirm}
                onChangeText={setConfirm}
                placeholder="Repeat password"
                placeholderTextColor={theme.colors.textTertiary}
                secureTextEntry
                autoComplete="new-password"
                style={{
                  backgroundColor: theme.colors.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  borderRadius: theme.radius.md,
                  padding: 14,
                  color: theme.colors.textPrimary,
                  fontSize: 16,
                }}
              />
            </View>

            {error ? (
              <Text style={{ color: theme.colors.accentRed, fontSize: 14, textAlign: 'center' }}>
                {error}
              </Text>
            ) : null}

            <Button
              title="Update password"
              onPress={handleSubmit}
              loading={loading}
              style={{ marginTop: 8 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}
