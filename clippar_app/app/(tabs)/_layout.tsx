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
import { config } from '@/constants/config';
import { useOnboardingTarget } from '@/hooks/useOnboardingTarget';
import { RecordingProvider, useRecordingContext } from '@/contexts/RecordingContext';

const RECORD_SIZE = 58;
const PILL_HEIGHT = 68;

// The hardware Shop (mount + clicker via Stripe) is hidden for the v1 App Store
// launch: its Stripe backend (create-payment-intent + stripe-webhook) isn't
// deployed yet, so a live Shop tab would be a dead end in review. To bring it
// back post-launch: deploy those functions, confirm the live Stripe key, then
// flip config.shop.inAppShopEnabled to true.
//
// The literal moved to constants/config.ts so the other entry points into the
// Shop can test the SAME flag — this file cannot hide the route on their
// behalf (see the note on `href: null` below). Kept as a local alias only
// because it reads better at the four use sites.
const SHOP_ENABLED = config.shop.inAppShopEnabled;

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
  const { isRecordingActive } = useRecordingContext();

  if (isRecordingActive) return null;

  const currentRoute = state.routes[state.index];
  const currentOptions = descriptors[currentRoute.key]?.options;
  if ((currentOptions?.tabBarStyle as any)?.display === 'none') return null;

  const getRoute = (name: string) => state.routes.find((r: any) => r.name === name);
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
      {/* Floating pill */}
      <View style={styles.pill}>
        {/* Left group: Rounds (+ Shop when enabled). flex weights by item count
            so every tab cell is the same width as the single right-side tab and
            the bar stays visually symmetrical. */}
        <View style={[styles.tabGroup, { flex: SHOP_ENABLED ? 2 : 1 }]}>
          <Pressable style={styles.tabItem} onPress={() => handlePress('index')}>
            <View ref={roundsRef} onLayout={roundsOnLayout}>
              <Home size={22} color={tintColor('index')} />
            </View>
            <Text style={[styles.tabLabel, { color: tintColor('index') }]}>Home</Text>
          </Pressable>
          {SHOP_ENABLED && (
            <Pressable style={styles.tabItem} onPress={() => handlePress('shop')}>
              <ShoppingBag size={22} color={tintColor('shop')} />
              <Text style={[styles.tabLabel, { color: tintColor('shop') }]}>Shop</Text>
            </Pressable>
          )}
        </View>

        {/* Record button sits inside the pill, in the center slot */}
        <RecordCTAButton
          focused={isFocused('record')}
          onPress={() => handlePress('record')}
        />

        {/* Right group: Profile */}
        <View style={[styles.tabGroup, styles.tabGroupRight]}>
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
  // Record button sits inside the pill, in the reserved center slot
  recordButtonWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    width: RECORD_SIZE + 16,
    height: RECORD_SIZE,
  },
  recordButtonPulse: {
    position: 'absolute',
    width: RECORD_SIZE,
    height: RECORD_SIZE,
    borderRadius: RECORD_SIZE / 2,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  // Weight groups by item count so every tab cell is the same width.
  // (Left group's flex is set inline since it depends on SHOP_ENABLED.)
  tabGroupRight: {
    flex: 1,
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
});

export default function TabLayout() {
  return (
    <RecordingProvider>
      <Tabs
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          // absolute so screen content extends behind the floating bar
          tabBarStyle: { position: 'absolute' },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="record" options={{ title: 'Record' }} />
        {/* href: null removes the Shop TAB BUTTON only. This used to claim it
            removed the route "so it's not reachable via deep link either" —
            it does not. The screen stays registered, and both
            router.push('/(tabs)/shop') and a deep link still land on it. Every
            route into the Shop must therefore gate itself on
            config.shop.inAppShopEnabled; this line only hides the tab. */}
        <Tabs.Screen
          name="shop"
          options={{ title: 'Shop', href: SHOP_ENABLED ? undefined : null }}
        />
        <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      </Tabs>
    </RecordingProvider>
  );
}
