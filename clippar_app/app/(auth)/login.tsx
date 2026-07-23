import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
} from 'react-native';
import { router } from 'expo-router';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { SocialAuthButtons } from '@/components/auth/SocialAuthButtons';
import { useAuth } from '@/hooks/useAuth';
import { resolvePostAuthRoute } from '@/lib/mountOffer';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { signIn } = useAuth();

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }

    setLoading(true);
    setError('');
    try {
      await signIn(email.trim(), password);
      // A brand-new account's FIRST login (post email-confirmation) shows
      // the one-time mount offer; every other login goes straight home.
      router.replace((await resolvePostAuthRoute()) as never);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

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
          {/* Logo / Title */}
          <View style={{ alignItems: 'center', marginBottom: 48 }}>
            <Image
              source={require('@/assets/images/clippar-logo-stacked.png')}
              style={{ width: 215, height: 140 }}
              resizeMode="contain"
              accessible
              accessibilityRole="image"
              accessibilityLabel="Clippar Golf"
            />
            <Text
              style={{
                ...theme.typography.bodySmall,
                color: theme.colors.textSecondary,
                marginTop: 12,
              }}
            >
              Every Shot. Remembered.
            </Text>
          </View>

          {/* Form */}
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
                Email
              </Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@email.com"
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
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
                Password
              </Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Enter password"
                placeholderTextColor={theme.colors.textTertiary}
                secureTextEntry
                autoComplete="password"
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
              title="Sign In"
              onPress={handleLogin}
              loading={loading}
              style={{ marginTop: 8 }}
            />

            {/* Typed-routes union is regenerated by expo dev server; cast the
                new path until that runs once. Removed automatically next time
                Metro boots. */}
            <Pressable onPress={() => router.push('/(auth)/forgot-password' as never)} hitSlop={8}>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 14,
                  textAlign: 'center',
                  marginTop: 4,
                }}
              >
                Forgot password?
              </Text>
            </Pressable>

            {/* Social auth can also CREATE an account (first "Continue with
                Apple/Google" on this screen) — resolvePostAuthRoute sends
                brand-new accounts to the one-time mount offer. */}
            <SocialAuthButtons
              onAuthSuccess={() => {
                void resolvePostAuthRoute().then((route) =>
                  router.replace(route as never)
                );
              }}
              onAuthError={setError}
            />

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: 16,
              }}
            >
              <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>
                Don't have an account?{' '}
              </Text>
              <Pressable onPress={() => router.push('/(auth)/signup')}>
                <Text style={{ color: theme.colors.primary, fontSize: 14, fontWeight: '600' }}>
                  Sign Up
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}
