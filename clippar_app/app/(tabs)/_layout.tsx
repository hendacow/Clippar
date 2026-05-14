import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Home, CircleDot, ShoppingBag, User } from 'lucide-react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';
import { useOnboardingTarget } from '@/hooks/useOnboardingTarget';

const RECORD_SIZE = 64;
const PILL_HEIGHT = 68;

function RecordCTAButton({
  focused,
  onPress,
}: {
  focused: boolean;
  onPress: () => void;
}) {
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);
  const { ref, onLayout } = useOnboardingTarget('record-button');

  useEffect(() => {
    if (focused) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.4, { duration: 1000 }),
          withTiming(1, { duration: 1000 })
        ),
        -1
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 1000 }),
          withTiming(0, { duration: 1000 })
        ),
        -1
      );
    } else {
      pulseScale.value = withTiming(1);
      pulseOpacity.value = withTiming(0);
    }
  }, [focused, pulseScale, pulseOpacity]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        onPress();
      }}
      style={styles.recordButtonWrapper}
    >
      <Animated.View style={[styles.recordButtonPulse, pulseStyle]} />
      <View ref={ref} onLayout={onLayout} style={styles.recordButtonInner}>
        <CircleDot size={28} color="#FFFFFF" strokeWidth={2.5} />
      </View>
    </Pressable>
  );
}

function FloatingTabBar({ state, descriptors, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { ref: roundsRef, onLayout: roundsOnLayout } = useOnboardingTarget('rounds-list');

  const currentRoute = state.routes[state.index];
  const currentOptions = descriptors[currentRoute.key]?.options;
  if ((currentOptions?.tabBarStyle as any)?.display === 'none') return null;

  const getRoute = (name: string) => state.routes.find((r) => r.name === name);
  const isFocused = (name: string) => state.routes[state.index].name === name;

  const handlePress = (routeName: string) => {
    const route = getRoute(routeName);
    if (!route) return;
    const focused = isFocused(routeName);
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });
    if (!focused && !event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  const tintColor = (name: string) =>
    isFocused(name) ? theme.colors.primary : theme.colors.textTertiary;

  return (
    <View
      style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}
      pointerEvents="box-none"
    >
      {/* Record button: floats above the pill, horizontally centered */}
      <RecordCTAButton
        focused={isFocused('record')}
        onPress={() => handlePress('record')}
      />

      {/* Floating pill */}
      <View style={styles.pill}>
        {/* Left group: Rounds + Shop */}
        <View style={styles.tabGroup}>
          <Pressable style={styles.tabItem} onPress={() => handlePress('index')}>
            <View ref={roundsRef} onLayout={roundsOnLayout}>
              <Home size={22} color={tintColor('index')} />
            </View>
            <Text style={[styles.tabLabel, { color: tintColor('index') }]}>Rounds</Text>
          </Pressable>
          <Pressable style={styles.tabItem} onPress={() => handlePress('shop')}>
            <ShoppingBag size={22} color={tintColor('shop')} />
            <Text style={[styles.tabLabel, { color: tintColor('shop') }]}>Shop</Text>
          </Pressable>
        </View>

        {/* Center gap reserved for the Record button */}
        <View style={styles.recordSpacer} />

        {/* Right group: Profile */}
        <View style={styles.tabGroup}>
          <Pressable style={styles.tabItem} onPress={() => handlePress('profile')}>
            <User size={22} color={tintColor('profile')} />
            <Text style={[styles.tabLabel, { color: tintColor('profile') }]}>Profile</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    // ensure touches pass through empty areas
  },
  // Record button sits above the pill; negative marginBottom overlaps pill by half
  recordButtonWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: -(RECORD_SIZE / 2),
    zIndex: 10,
    width: RECORD_SIZE + 16,
    height: RECORD_SIZE + 16,
  },
  recordButtonPulse: {
    position: 'absolute',
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: theme.colors.primary,
  },
  recordButtonInner: {
    width: RECORD_SIZE,
    height: RECORD_SIZE,
    borderRadius: RECORD_SIZE / 2,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.shadows.glow,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginHorizontal: 20,
    borderRadius: 40,
    height: PILL_HEIGHT,
    paddingHorizontal: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 14,
  },
  tabGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  // reserves horizontal space in the pill for the floating Record button
  recordSpacer: {
    width: RECORD_SIZE + 16,
  },
});

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // absolute so screen content extends behind the floating bar
        tabBarStyle: { position: 'absolute' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Rounds' }} />
      <Tabs.Screen name="record" options={{ title: 'Record' }} />
      <Tabs.Screen name="shop" options={{ title: 'Shop' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
