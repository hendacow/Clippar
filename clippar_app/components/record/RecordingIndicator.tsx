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
  // Two separate animated dims so we can morph between an idle circle and a
  // recording stop-square without letting the inner element's corners punch
  // through the outer ring (a 56×56 near-square has a diagonal larger than
  // the ring's 64px interior — shrinking on record fixes that).
  const pulseScale = useSharedValue(1);
  const innerSize = useSharedValue(56);
  const innerRadius = useSharedValue(28);

  useEffect(() => {
    if (isRecording) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.08, { duration: 900 }),
          withTiming(1, { duration: 900 })
        ),
        -1
      );
      innerSize.value = withTiming(28, { duration: 220 });
      innerRadius.value = withTiming(6, { duration: 220 });
    } else {
      pulseScale.value = withTiming(1, { duration: 220 });
      innerSize.value = withTiming(56, { duration: 220 });
      innerRadius.value = withTiming(28, { duration: 220 });
    }
  }, [isRecording, pulseScale, innerSize, innerRadius]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  const innerStyle = useAnimatedStyle(() => ({
    width: innerSize.value,
    height: innerSize.value,
    borderRadius: innerRadius.value,
  }));

  return (
    <Animated.View style={pulseStyle}>
      <View
        style={{
          width: 76,
          height: 76,
          borderRadius: 38,
          borderWidth: 4,
          borderColor: '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'transparent',
          // Any overshoot during the radius/size spring still gets clipped
          // by the ring itself — belt-and-suspenders against corner bleed.
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={[
            {
              backgroundColor: '#FF3B30',
            },
            innerStyle,
          ]}
        />
      </View>
    </Animated.View>
  );
}
