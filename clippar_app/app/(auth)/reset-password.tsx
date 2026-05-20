import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';

// OTP-based password reset. The user typed their email on forgot-password,
// triggered Supabase's resetPasswordForEmail, and was routed here with the
// email pre-filled in params. The email they received contains a 6-digit
// code (Token in Supabase's template). We verify it server-side via
// verifyOtp, then update the password in the same submit.
//
// Why a code instead of a clickable link: clickable recovery links are
// single-use, and email pipelines (Gmail, iOS Mail link previews, scanners)
// frequently pre-fetch the URL, consuming the token before the user can.
// A code that the user types in by hand sidesteps that entirely.
export default function ResetPasswordScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const initialEmail = (params.email ?? '').trim();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const trimmedCode = code.trim();

    if (!trimmedEmail) {
      setError('Please enter your email');
      return;
    }
    // Supabase's email-based recovery OTP is 6 OR 8 digits depending on
    // the project's auth setting. Accept any length the user typed; the
    // verifyOtp call below will reject anything malformed.
    if (trimmedCode.length < 6) {
      setError('Enter the code from your email');
      return;
    }
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
      // Step 1: verify the OTP and establish a recovery session.
      const { error: otpErr } = await supabase.auth.verifyOtp({
        email: trimmedEmail,
        token: trimmedCode,
        type: 'recovery',
      });
      if (otpErr) {
        // Supabase returns a generic "Token has expired or is invalid"
        // for any of: wrong code, expired code, already-used code. Surface
        // verbatim so the user knows to request a fresh one.
        throw otpErr;
      }

      // Step 2: with the recovery session active, update the password.
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;

      // Step 3: sign out so the recovery session doesn't linger. The user
      // logs in with the new password fresh.
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

  return (
    <GradientBackground>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            // Sit content below the status bar / dynamic island. The form is
            // tall enough on this screen that centering it overflowed the top
            // safe area on devices with a notch.
            paddingTop: insets.top + 56,
            paddingBottom: insets.bottom + theme.spacing.lg,
            paddingHorizontal: theme.spacing.lg,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => router.back()}
            style={{
              position: 'absolute',
              top: insets.top + 12,
              left: theme.spacing.lg,
              zIndex: 1,
            }}
            hitSlop={12}
          >
            <ArrowLeft size={24} color={theme.colors.textSecondary} />
          </Pressable>

          <View style={{ alignItems: 'center', marginBottom: 24 }}>
            <Text
              style={{
                ...theme.typography.h1,
                color: theme.colors.textPrimary,
                fontSize: 28,
                letterSpacing: -0.5,
              }}
            >
              Enter your reset code
            </Text>
            <Text
              style={{
                ...theme.typography.bodySmall,
                color: theme.colors.textSecondary,
                marginTop: 8,
                textAlign: 'center',
                paddingHorizontal: 12,
              }}
            >
              {initialEmail
                ? `We sent a reset code to ${initialEmail}. It expires in 1 hour.`
                : 'Enter the email and the code we just sent you.'}
            </Text>
          </View>

          <View style={{ gap: 16 }}>
            {/* Email — editable if we didn't get it from the previous screen,
                read-only if we did, so the user can't accidentally mis-edit. */}
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
                editable={!initialEmail}
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
                  color: initialEmail ? theme.colors.textTertiary : theme.colors.textPrimary,
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
                Reset code
              </Text>
              <TextInput
                value={code}
                onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 8))}
                placeholder="Paste the code from your email"
                placeholderTextColor={theme.colors.textTertiary}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={8}
                style={{
                  backgroundColor: theme.colors.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  borderRadius: theme.radius.md,
                  padding: 14,
                  color: theme.colors.textPrimary,
                  fontSize: 22,
                  letterSpacing: 4,
                  textAlign: 'center',
                  fontWeight: '600',
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
              title="Reset password"
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
