import { View, Text, Pressable, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Clock, MapPin } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { CARD_GRADIENTS } from '@/constants/mockData';
import type { MockRound } from '@/constants/mockData';
import { ReelPreview } from './ReelPreview';

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

interface RoundCardHorizontalProps {
  round: MockRound;
  index: number;
  onPress: () => void;
  onDelete?: () => void;
  size?: 'default' | 'large';
  /** Signed URL for the reel video (if available) */
  reelSignedUrl?: string;
}

export function RoundCardHorizontal({ round, index, onPress, onDelete, size = 'default', reelSignedUrl }: RoundCardHorizontalProps) {
  const cardWidth = size === 'large' ? 200 : 170;
  const cardHeight = size === 'large' ? 210 : 180;
  const gradient = CARD_GRADIENTS[index % CARD_GRADIENTS.length];

  const handleLongPress = () => {
    if (!onDelete) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      'Delete this round?',
      'This will permanently delete the round, all clips, and the highlight reel. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]
    );
  };

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      onLongPress={handleLongPress}
    >
      <View
        style={{
          width: cardWidth,
          height: cardHeight,
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
        }}
      >
        {/* Looping reel preview when signed URL is available */}
        {reelSignedUrl ? (
          <View style={{ position: 'absolute', width: '100%', height: '100%' }}>
            <ReelPreview signedUrl={reelSignedUrl} height={cardHeight} />
          </View>
        ) : null}
        <LinearGradient
          colors={reelSignedUrl ? ['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.75)'] : gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ flex: 1, padding: 14, justifyContent: 'space-between' }}
        >
          {/* Top: Status / Play icon */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            {round.status === 'ready' && round.reel_url ? (
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  backgroundColor: 'rgba(76, 175, 80, 0.8)',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Play size={14} color="#FFFFFF" fill="#FFFFFF" style={{ marginLeft: 1 }} />
              </View>
            ) : round.status === 'processing' ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(255, 152, 0, 0.2)',
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: theme.radius.full,
                }}
              >
                <Clock size={10} color={theme.colors.processing} />
                <Text style={{ color: theme.colors.processing, fontSize: 10, fontWeight: '600' }}>
                  Processing
                </Text>
              </View>
            ) : (
              <View />
            )}

            {/* Score */}
            {round.total_score != null && (
              <View style={{ alignItems: 'flex-end' }}>
                <Text
                  style={{
                    fontSize: 28,
                    fontWeight: '900',
                    color: getScoreColor(round.score_to_par),
                    letterSpacing: -1,
                  }}
                >
                  {round.total_score}
                </Text>
                {round.score_to_par != null && (
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '700',
                      color: getScoreColor(round.score_to_par),
                      marginTop: -3,
                    }}
                  >
                    {formatScoreToPar(round.score_to_par)}
                  </Text>
                )}
              </View>
            )}
          </View>

          {/* Bottom: Course + date */}
          <View>
            {round.best_hole && round.best_hole.label !== 'Par' && (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  marginBottom: 6,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor:
                      round.best_hole.label === 'Eagle' ? theme.colors.accentGold : theme.colors.primary,
                  }}
                />
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '600',
                    color:
                      round.best_hole.label === 'Eagle' ? theme.colors.accentGold : theme.colors.primary,
                  }}
                >
                  {round.best_hole.label} on #{round.best_hole.hole}
                </Text>
              </View>
            )}
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 14,
                fontWeight: '700',
              }}
              numberOfLines={1}
            >
              {round.course_name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
                {new Date(round.date).toLocaleDateString('en-AU', {
                  day: 'numeric',
                  month: 'short',
                })}
              </Text>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>·</Text>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
                {round.clips_count} clips
              </Text>
            </View>
          </View>
        </LinearGradient>
      </View>
    </Pressable>
  );
}
