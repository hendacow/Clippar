import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Button } from '@/components/ui/Button';

export default function OnboardingScreen() {
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
        <Text
          style={{
            ...theme.typography.h1,
            color: theme.colors.primary,
            textAlign: 'center',
            marginBottom: 16,
          }}
        >
          Welcome to Clippar
        </Text>
        <Text
          style={{
            ...theme.typography.body,
            color: theme.colors.textSecondary,
            textAlign: 'center',
            marginBottom: 48,
            maxWidth: 300,
          }}
        >
          Record every shot, get automatic highlight reels, and build your personal golf library.
        </Text>

        <View style={{ gap: 16, width: '100%', maxWidth: 340 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              padding: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: theme.colors.primaryMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18 }}>1</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                Pair your clicker
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                Connect via Bluetooth in Settings
              </Text>
            </View>
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              padding: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: theme.colors.primaryMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18 }}>2</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                Tap before & after each shot
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                First tap starts, second tap stops recording
              </Text>
            </View>
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              padding: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: theme.colors.primaryMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18 }}>3</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600', fontSize: 15 }}>
                Upload & get your reel
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                AI processes your footage into a highlight reel
              </Text>
            </View>
          </View>
        </View>

        <Button
          title="Get Started"
          onPress={() => router.replace('/(tabs)')}
          style={{ marginTop: 48, width: '100%', maxWidth: 340 }}
        />
      </View>
    </GradientBackground>
  );
}
