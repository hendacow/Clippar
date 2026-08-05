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
  Linking,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { SocialAuthButtons } from '@/components/auth/SocialAuthButtons';
import { useAuth } from '@/hooks/useAuth';
import { markMountOfferPending, resolvePostAuthRoute } from '@/lib/mountOffer';
import { authContentJustify } from '@/lib/authLayoutLogic';

export default function SignUpScreen() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const { signUp } = useAuth();
  const insets = useSafeAreaInsets();
  // Track content vs viewport so we can center only when it fits — otherwise
  // top-align so the logo stays fully below the Dynamic Island and reachable.
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const handleSignUp = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { needsEmailConfirmation } = await signUp(
        email.trim(),
        password,
        displayName.trim() || undefined
      );
      // Flag the new account locally so its first arrival shows the one-time
      // mount offer (lib/mountOffer). Scoped to this email so another account
      // logging in next never inherits the offer. Awaited rather than
      // fire-and-forget, because resolvePostAuthRoute below reads exactly what
      // this writes — racing them sent brand-new accounts straight past the
      // offer they had just been marked for.
      await markMountOfferPending(email);

      if (needsEmailConfirmation) {
        // No session: the project requires a confirmation click before this
        // account can sign in. Tell the user to go and find that email.
        setSuccess(true);
        return;
      }
      // Signed in already — sending them to "Check Your Email" would strand
      // them waiting on a message that is never sent. Go where a login goes.
      router.replace((await resolvePostAuthRoute()) as never);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Sign up failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
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
            Check Your Email
          </Text>
          <Text
            style={{
              ...theme.typography.body,
              color: theme.colors.textSecondary,
              textAlign: 'center',
              marginBottom: 32,
            }}
          >
            We've sent a confirmation link to {email}. Tap the link to activate your account.
          </Text>
          <Button title="Back to Login" onPress={() => router.back()} variant="secondary" />
        </View>
      </GradientBackground>
    );
  }

  return (
    <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          onLayout={(e) => setViewportHeight(e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => setContentHeight(h)}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: authContentJustify(contentHeight, viewportHeight),
            padding: theme.spacing.lg,
            // Guarantee the logo clears the status bar / Dynamic Island on every
            // iPhone, even in the overflow (top-aligned) case.
            paddingTop: theme.spacing.lg + insets.top,
          }}
          keyboardShouldPersistTaps="handled"
        >
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
              Create your account
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
                Display Name
              </Text>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Your name"
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="words"
                autoComplete="name"
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

            {error ? (
              <Text style={{ color: theme.colors.accentRed, fontSize: 14, textAlign: 'center' }}>
                {error}
              </Text>
            ) : null}

            <Button
              title="Create Account"
              onPress={handleSignUp}
              loading={loading}
              style={{ marginTop: 8 }}
            />

            {/* Social auth creates the account + session in one step. Route
                through resolvePostAuthRoute so a brand-new account sees the
                one-time mount offer; an existing account signing in here
                goes straight to the tabs. */}
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
                Already have an account?{' '}
              </Text>
              <Pressable onPress={() => router.back()}>
                <Text style={{ color: theme.colors.primary, fontSize: 14, fontWeight: '600' }}>
                  Sign In
                </Text>
              </Pressable>
            </View>

            {/* Legal — visible at sign-up per App Review 5.1.1 (and required
                when a subscription is offered). Links open the canonical
                policy pages hosted on the marketing site. */}
            <View style={{ alignItems: 'center', marginTop: 4 }}>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 12, textAlign: 'center' }}>
                By creating an account you agree to our{' '}
                <Text
                  style={{ color: theme.colors.textSecondary, fontWeight: '600' }}
                  onPress={() => Linking.openURL('https://clippargolf.com/terms')}
                >
                  Terms of Service
                </Text>
                {' '}and{' '}
                <Text
                  style={{ color: theme.colors.textSecondary, fontWeight: '600' }}
                  onPress={() => Linking.openURL('https://clippargolf.com/privacy')}
                >
                  Privacy Policy
                </Text>
                .
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}
