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
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import {
  getRecoveryState,
  subscribeRecovery,
  resetRecoveryBus,
} from '@/lib/recoveryLinkBus';

export default function ResetPasswordScreen() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [linkReady, setLinkReady] = useState<'pending' | 'ready' | 'invalid'>('pending');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // The deep-link URL has already been parsed by app/_layout.tsx's
  // module-level listener (which beats the OS race that the in-screen
  // listener loses). We just read the resulting state here.
  useEffect(() => {
    const apply = (s: ReturnType<typeof getRecoveryState>) => {
      console.log('[reset-password] recoveryBus state=', s);
      if (s.kind === 'ready') {
        setLinkReady('ready');
      } else if (s.kind === 'invalid') {
        setLinkReady('invalid');
        setError(s.message);
      }
    };

    apply(getRecoveryState());
    const unsub = subscribeRecovery(apply);

    // Safety net: if nothing arrives in 5s, surface invalid.
    const deadlineId = setTimeout(() => {
      if (getRecoveryState().kind === 'pending') {
        console.log('[reset-password] 5s deadline, marking invalid');
        setLinkReady('invalid');
        setError(
          'We didn’t receive a valid reset link. Request a new one from the login screen.'
        );
      }
    }, 5000);

    return () => {
      unsub();
      clearTimeout(deadlineId);
      // Reset the bus so the next attempt starts clean (otherwise a stale
      // 'invalid' from a previous link would flash on the next mount).
      resetRecoveryBus();
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
