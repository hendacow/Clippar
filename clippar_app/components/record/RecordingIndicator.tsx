import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface RecordingIndicatorProps {
  isRecording: boolean;
  onPress?: () => void;
}

export function RecordingIndicator({ isRecording }: RecordingIndicatorProps) {
  const pulseScale = useSharedValue(1);
  const innerRadius = useSharedValue(28);

  useEffect(() => {
    if (isRecording) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 800 }),
          withTiming(1, { duration: 800 })
        ),
        -1
      );
      innerRadius.value = withTiming(8, { duration: 200 });
    } else {
      pulseScale.value = withTiming(1, { duration: 200 });
      innerRadius.value = withTiming(28, { duration: 200 });
    }
  }, [isRecording, pulseScale, innerRadius]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  const innerStyle = useAnimatedStyle(() => ({
    borderRadius: innerRadius.value,
  }));

  return (
    <Animated.View style={pulseStyle}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          borderWidth: 4,
          borderColor: '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'transparent',
        }}
      >
        <Animated.View
          style={[
            {
              width: 56,
              height: 56,
              backgroundColor: '#FF3B30',
            },
            innerStyle,
          ]}
        />
      </View>
    </Animated.View>
  );
}
