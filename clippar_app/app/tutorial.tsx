/**
 * v3 tutorial bootstrap — the one screen between signup and the REAL app.
 *
 * Creates the scoped scratch round through the production path, points the
 * record tab at it (tutorial.active_round), and hands over. The record tab
 * recognises the sentinel course name, swaps the camera feed for the demo
 * video, and its coach overlay teaches on genuine round state. Plan §12.
 */
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable } from 'react-native';
import { router, Stack } from 'expo-router';
import { theme } from '@/constants/theme';
import { createTutorialRound, setTutorialPending } from '@/lib/tutorialRound';

export default function TutorialBootstrapScreen() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await createTutorialRound();
        if (!alive) return;
        router.replace('/(tabs)/record');
      } catch {
        if (!alive) return;
        // The tutorial must never trap a brand-new account: clear the flag
        // and let them into the app; the coach is a nicety, not a gate.
        await setTutorialPending(false).catch(() => {});
        setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
        {!failed ? (
          <>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>Setting up your walkthrough…</Text>
          </>
        ) : (
          <>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
              Couldn't set up the walkthrough
            </Text>
            <Pressable onPress={() => router.replace('/(tabs)')} style={{ backgroundColor: theme.colors.primary, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 12 }}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Into the app</Text>
            </Pressable>
          </>
        )}
      </View>
    </>
  );
}
