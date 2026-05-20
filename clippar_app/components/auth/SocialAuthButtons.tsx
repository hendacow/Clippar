import { useState } from 'react';
import { View, Text, Pressable, Platform, ActivityIndicator } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  // Caller-supplied success handler — usually navigation to the home stack.
  onAuthSuccess: () => void;
  // Caller-supplied error display. Surface auth failures here so each screen
  // can render them consistently with its own error UI.
  onAuthError: (message: string) => void;
}

export function SocialAuthButtons({ onAuthSuccess, onAuthError }: Props) {
  const { signInWithGoogle, signInWithApple } = useAuth();
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);

  const handleGoogle = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
      onAuthSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed';
      // 'cancelled' is the soft cancel the hook throws when the user dismisses
      // the browser sheet — don't show that as an error.
      if (message !== 'cancelled') onAuthError(message);
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleApple = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAppleLoading(true);
    try {
      await signInWithApple();
      onAuthSuccess();
    } catch (err: unknown) {
      // Apple's signInAsync throws ERR_REQUEST_CANCELED when the user dismisses.
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ERR_REQUEST_CANCELED') return;
      const message = err instanceof Error ? err.message : 'Apple sign-in failed';
      onAuthError(message);
    } finally {
      setAppleLoading(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {/* Divider with "or" label — separates email auth from social options. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginVertical: 4,
        }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceBorder }} />
        <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>or</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceBorder }} />
      </View>

      {/* Apple Sign-In — iOS only. Uses Apple's official button component for
          guideline compliance (auto-sized, correct styling per HIG). Apple
          Sign-In has been available on every iOS 13+ device since 2019, well
          below our minimum target, so no runtime availability check needed. */}
      {Platform.OS === 'ios' && (
        <View style={{ height: 50, position: 'relative' }}>
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={theme.radius.full}
            style={{ width: '100%', height: '100%' }}
            onPress={handleApple}
          />
          {appleLoading && (
            <View
              style={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(0,0,0,0.4)',
                borderRadius: theme.radius.full,
              }}
            >
              <ActivityIndicator color="#000000" />
            </View>
          )}
        </View>
      )}

      {/* Google Sign-In — universal styling. White button with Google-blue "G"
          marker. Branded "G" SVG isn't in our icon set; the colored letter is
          clear enough and stays within fair-use for in-app login until we
          adopt an SVG icon package. */}
      <Pressable
        onPress={handleGoogle}
        disabled={googleLoading}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          height: 50,
          paddingHorizontal: 24,
          borderRadius: theme.radius.full,
          backgroundColor: '#FFFFFF',
          gap: 12,
          opacity: googleLoading ? 0.6 : pressed ? 0.85 : 1,
        })}
      >
        {googleLoading ? (
          <ActivityIndicator color="#1F1F1F" size="small" />
        ) : (
          <>
            <Text
              style={{
                fontSize: 18,
                fontWeight: '800',
                color: '#4285F4',
                lineHeight: 22,
              }}
            >
              G
            </Text>
            <Text style={{ color: '#1F1F1F', fontSize: 16, fontWeight: '600' }}>
              Continue with Google
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}
