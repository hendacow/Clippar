import { useEffect, useState } from 'react';
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

// Parses tokens out of a Supabase recovery callback URL.
// Supabase sends users back to <scheme>://reset-password with the recovery
// session in the URL fragment: #access_token=...&refresh_token=...&type=recovery
function parseRecoveryTokens(url: string | null): { access: string; refresh: string } | null {
  if (!url) return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.substring(hashIndex + 1));
  if (params.get('type') !== 'recovery') return null;
  const access = params.get('access_token');
  const refresh = params.get('refresh_token');
  if (!access || !refresh) return null;
  return { access, refresh };
}

export default function ResetPasswordScreen() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [linkReady, setLinkReady] = useState<'pending' | 'ready' | 'invalid'>('pending');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // On mount, grab the initial URL (the one that opened the app from the
  // email tap) plus subscribe to subsequent url events in case the user is
  // already in the app when the link fires. First valid recovery URL wins.
  useEffect(() => {
    let mounted = true;

    const consume = async (url: string | null) => {
      const tokens = parseRecoveryTokens(url);
      if (!tokens) return false;
      const { error: setErr } = await supabase.auth.setSession({
        access_token: tokens.access,
        refresh_token: tokens.refresh,
      });
      if (!mounted) return true;
      if (setErr) {
        setLinkReady('invalid');
        setError(setErr.message);
      } else {
        setLinkReady('ready');
      }
      return true;
    };

    (async () => {
      const initial = await Linking.getInitialURL();
      const consumed = await consume(initial);
      if (!consumed && mounted) {
        // Initial URL didn't have recovery tokens. Wait briefly for a url
        // event in case the deep link is still in flight, then mark invalid.
        const sub = Linking.addEventListener('url', (e) => {
          consume(e.url);
        });
        setTimeout(() => {
          if (mounted && linkReady === 'pending') setLinkReady('invalid');
        }, 1500);
        return () => sub.remove();
      }
    })();

    return () => {
      mounted = false;
    };
    // linkReady intentionally omitted: we only want this effect to fire once
    // on mount; updating linkReady from inside re-running the effect would
    // bounce the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
