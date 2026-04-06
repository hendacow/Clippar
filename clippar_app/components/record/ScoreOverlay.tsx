import { View, Text } from 'react-native';
import { Circle } from 'lucide-react-native';
import { theme } from '@/constants/theme';

interface ScoreOverlayProps {
  holeNumber: number;
  par: number;
  currentShot: number;
  scoreToPar: number;
  isRecording?: boolean;
  topInset?: number;
}

export function ScoreOverlay({
  holeNumber,
  par,
  currentShot,
  scoreToPar,
  isRecording,
  topInset = 0,
}: ScoreOverlayProps) {
  const scoreColor =
    scoreToPar < 0
      ? theme.colors.birdie
      : scoreToPar === 0
        ? theme.colors.par
        : scoreToPar <= 4
          ? theme.colors.bogey
          : theme.colors.doubleBogey;

  return (
    <View
      style={{
        position: 'absolute',
        top: topInset + 8,
        left: 12,
        right: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      }}
    >
      {/* Hole + Par */}
      <View
        style={{
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderRadius: theme.radius.sm,
          paddingHorizontal: 10,
          paddingVertical: 6,
        }}
      >
        <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '700' }}>
          Hole {holeNumber}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>
          Par {par}
        </Text>
      </View>

      {/* Recording indicator */}
      {isRecording && (
        <View
          style={{
            backgroundColor: 'rgba(255,59,48,0.85)',
            borderRadius: 12,
            paddingHorizontal: 10,
            paddingVertical: 5,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Circle size={8} color="#FFFFFF" fill="#FFFFFF" />
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>REC</Text>
        </View>
      )}

      {/* Shot + Score */}
      <View
        style={{
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderRadius: theme.radius.sm,
          paddingHorizontal: 10,
          paddingVertical: 6,
          alignItems: 'flex-end',
        }}
      >
        <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '700' }}>
          Shot {currentShot}
        </Text>
        <Text style={{ color: scoreColor, fontSize: 11, fontWeight: '600' }}>
          {scoreToPar === 0 ? 'E' : scoreToPar > 0 ? `+${scoreToPar}` : scoreToPar}
        </Text>
      </View>
    </View>
  );
}
