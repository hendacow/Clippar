import { View, Text, Pressable, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Film } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import { theme } from '@/constants/theme';
import type { MockRound } from '@/constants/mockData';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

function getScoreColor(scoreToPar: number | null): string {
  if (scoreToPar === null) return theme.colors.textSecondary;
  if (scoreToPar < 0) return theme.colors.birdie;
  if (scoreToPar === 0) return theme.colors.par;
  if (scoreToPar <= 4) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

function formatScoreToPar(scoreToPar: number): string {
  if (scoreToPar === 0) return 'E';
  return scoreToPar > 0 ? `+${scoreToPar}` : `${scoreToPar}`;
}

interface HeroReelProps {
  round: MockRound;
  onPress: () => void;
}

export function HeroReel({ round, onPress }: HeroReelProps) {
  const pulseScale = useSharedValue(1);

  useEffect(() => {
    pulseScale.value = withRepeat(
      withSequence(
        withTiming(1.05, { duration: 2000 }),
        withTiming(1, { duration: 2000 })
      ),
      -1
    );
  }, [pulseScale]);

  const playButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
    >
      <View
        style={{
          width: SCREEN_WIDTH - 32,
          height: 220,
          marginHorizontal: 16,
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          marginBottom: 20,
        }}
      >
        {/* Background gradient (placeholder for video thumbnail) */}
        <LinearGradient
          colors={['#1a3a2a', '#0d1f15', '#0A0A0F']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', width: '100%', height: '100%' }}
        />

        {/* Course pattern overlay */}
        <View
          style={{
            position: 'absolute',
            top: 20,
            right: 20,
            opacity: 0.06,
          }}
        >
          <Film size={120} color="#FFFFFF" />
        </View>

        {/* Bottom gradient for text legibility */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.8)']}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '60%',
          }}
        />

        {/* Play button center */}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Animated.View
            style={[
              {
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: 'rgba(76, 175, 80, 0.9)',
                justifyContent: 'center',
                alignItems: 'center',
                ...theme.shadows.glow,
              },
              playButtonStyle,
            ]}
          >
            <Play size={28} color="#FFFFFF" fill="#FFFFFF" style={{ marginLeft: 3 }} />
          </Animated.View>
        </View>

        {/* Top label */}
        <View
          style={{
            position: 'absolute',
            top: 14,
            left: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <View
            style={{
              backgroundColor: theme.colors.primary,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: theme.radius.full,
            }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>
              LATEST HIGHLIGHT
            </Text>
          </View>
        </View>

        {/* Bottom content */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 16,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
          }}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 20,
                fontWeight: '800',
                letterSpacing: -0.3,
              }}
            >
              {round.course_name}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>
              {new Date(round.date).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
              })}{' '}
              · {round.clips_count} clips · {round.holes_played} holes
            </Text>
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            {round.total_score != null && (
              <Text
                style={{
                  fontSize: 36,
                  fontWeight: '900',
                  color: getScoreColor(round.score_to_par),
                  letterSpacing: -1,
                }}
              >
                {round.total_score}
              </Text>
            )}
            {round.score_to_par != null && (
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: '700',
                  color: getScoreColor(round.score_to_par),
                  marginTop: -4,
                }}
              >
                {formatScoreToPar(round.score_to_par)}
              </Text>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}
