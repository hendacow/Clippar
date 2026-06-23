/**
 * The 9 screens of the cold-start golfer sales funnel. Each is a pure
 * presentational component driven by the host stepper (app/(onboarding)/index).
 * Reanimated 4 + expo-video + react-native-svg + expo-haptics — no new deps.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Dimensions,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withRepeat,
  withSequence,
  Easing,
  FadeIn,
} from 'react-native-reanimated';
import { Share2, BarChart3, Film, Check, Sparkles } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import {
  flowAssets,
  handicapOptions,
  goalOptions,
  goalRecap,
  testimonials,
  proofStats,
  trialConfig,
  type HandicapBand,
  type GolferGoal,
} from '@/constants/onboardingFlow';
import {
  FlowButton,
  ProgressDots,
  TapChip,
  StarRating,
  CountUp,
  TrialTimeline,
} from './primitives';
import { TracerArc } from './TracerArc';

const { width: SCREEN_W } = Dimensions.get('window');

export interface ScreenProps {
  onNext: () => void;
  onSkip: () => void;
  onPrimary: () => void; // funnel exit (→ signup)
  onSecondary: () => void; // login / maybe-later
  handicap: HandicapBand | null;
  goal: GolferGoal | null;
  setHandicap: (h: HandicapBand) => void;
  setGoal: (g: GolferGoal) => void;
}

/* ── Shared entrance wrapper ──────────────────────────────────────────── */
function Rise({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: object }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) }));
  }, [delay, v]);
  const a = useAnimatedStyle(() => ({
    opacity: v.value,
    transform: [{ translateY: (1 - v.value) * 16 }],
  }));
  return <Animated.View style={[a, style]}>{children}</Animated.View>;
}

function TrustStrip() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
      <StarRating value={5} size={13} animate={false} />
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>
        {proofStats.rating}★ · {proofStats.golfers} Aussie golfers
      </Text>
    </View>
  );
}

function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}
function Sub({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sub}>{children}</Text>;
}

/* ════════════════════ 1. HOOK ════════════════════ */
export function HookIntro({ onNext, onSecondary }: ScreenProps) {
  const player = useVideoPlayer(flowAssets.heroReel, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay' && !ready) {
        setReady(true);
        Haptics.selectionAsync();
      }
    });
    return () => sub.remove();
  }, [player, ready]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <ExpoImage
        source={flowAssets.heroPoster}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={0}
      />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
        />
      </Animated.View>
      <LinearGradient
        colors={['transparent', 'rgba(10,10,15,0.5)', '#0A0A0F']}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: 24, gap: 16 }}>
        <Rise delay={150}>
          <H1>Every shot.{'\n'}Remembered.</H1>
        </Rise>
        <Rise delay={300}>
          <Sub>Your phone on the buggy filmed the round. We already cut the highlights.</Sub>
        </Rise>
        <Rise delay={450} style={{ gap: 14, marginTop: 8 }}>
          <TrustStrip />
          <FlowButton label="Show me how" onPress={onNext} />
          <Pressable onPress={onSecondary} hitSlop={8} style={{ alignSelf: 'center' }}>
            <Text style={styles.secondaryLink}>I already have an account</Text>
          </Pressable>
        </Rise>
      </View>
    </View>
  );
}

/* ════════════════════ 2. Q: HANDICAP ════════════════════ */
export function QHandicap({ onNext, onSkip, handicap, setHandicap }: ScreenProps) {
  return (
    <QuestionShell
      step={0}
      title="What's your game like?"
      sub="So we tune swing detection and the tracer to your tempo."
      onSkip={onSkip}
    >
      {handicapOptions.map((o, i) => (
        <TapChip
          key={o.id}
          label={o.label}
          selected={handicap === o.id}
          dimmed={handicap !== null && handicap !== o.id}
          delay={i * 70}
          onPress={() => {
            setHandicap(o.id);
            setTimeout(onNext, 260);
          }}
        />
      ))}
    </QuestionShell>
  );
}

/* ════════════════════ 3. Q: GOAL ════════════════════ */
export function QGoal({ onNext, onSkip, goal, setGoal }: ScreenProps) {
  const icons = {
    share: <Share2 size={20} color={theme.colors.primary} />,
    chart: <BarChart3 size={20} color={theme.colors.primary} />,
    film: <Film size={20} color={theme.colors.primary} />,
  };
  return (
    <QuestionShell
      step={1}
      title="What do you want out of it?"
      sub="Pick one — we'll set the app up around it."
      onSkip={onSkip}
    >
      {goalOptions.map((o, i) => (
        <TapChip
          key={o.id}
          label={o.label}
          icon={icons[o.icon]}
          selected={goal === o.id}
          dimmed={goal !== null && goal !== o.id}
          delay={i * 70}
          onPress={() => {
            setGoal(o.id);
            setTimeout(() => {
              Haptics.selectionAsync();
              onNext();
            }, 260);
          }}
        />
      ))}
    </QuestionShell>
  );
}

function QuestionShell({
  step,
  title,
  sub,
  onSkip,
  children,
}: {
  step: number;
  title: string;
  sub: string;
  onSkip: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: 24, paddingTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <ProgressDots count={2} index={step} />
        <Pressable onPress={onSkip} hitSlop={10}>
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
      <Rise delay={60}><H1>{title}</H1></Rise>
      <Rise delay={160}><Sub>{sub}</Sub></Rise>
      <View style={{ gap: 12, marginTop: 28 }}>{children}</View>
    </View>
  );
}

/* ════════════════════ 4. VALUE: AUTO-CUT ════════════════════ */
export function ValueAutocut({ onNext }: ScreenProps) {
  const clips = [
    { uri: flowAssets.raw, poster: flowAssets.poster1, tag: 'Raw' },
    { uri: flowAssets.detected, poster: flowAssets.poster2, tag: 'AI detects the swing' },
    { uri: flowAssets.clean, poster: flowAssets.poster3, tag: 'Clean cut' },
  ];
  return (
    <ValueShell
      title="Raw footage in. Clean shots out."
      sub="4 hours on the course becomes a 90-second reel. We watch the boring bits so you don't."
      onNext={onNext}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SCREEN_W * 0.66 + 12}
        decelerationRate="fast"
        contentContainerStyle={{ gap: 12, paddingHorizontal: 4 }}
      >
        {clips.map((c, i) => (
          <ClipCard key={i} {...c} />
        ))}
      </ScrollView>
      <Rise delay={400} style={{ alignItems: 'center', marginTop: 20 }}>
        <CountUp to={200} prefix="~" milestones={[50, 100, 150, 200]} style={{ color: theme.colors.primary, fontSize: 44 }} />
        <Text style={styles.statCaption}>clips auto-trimmed this round</Text>
      </Rise>
    </ValueShell>
  );
}

function ClipCard({ uri, poster, tag }: { uri: string; poster: string; tag: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return (
    <View style={{ width: SCREEN_W * 0.66, height: SCREEN_W * 1.05, borderRadius: 20, overflow: 'hidden', backgroundColor: theme.colors.surface }}>
      <ExpoImage source={poster} style={StyleSheet.absoluteFill} contentFit="cover" />
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
      <View style={styles.clipTag}>
        <Text style={styles.clipTagText}>{tag}</Text>
      </View>
    </View>
  );
}

/* ════════════════════ 5. VALUE: TRACER ════════════════════ */
export function ValueTracer({ onNext }: ScreenProps) {
  const [replay, setReplay] = useState(0);
  const arcW = SCREEN_W - 48;
  const arcH = arcW * 0.62;
  return (
    <ValueShell
      title="See exactly where that one went."
      sub="Every full swing gets a tracer arc — looks like the telecast, drawn from your real GPS."
      onNext={onNext}
    >
      <Pressable onPress={() => setReplay((r) => r + 1)} style={{ alignSelf: 'center' }}>
        <View style={{ width: arcW, height: arcH, borderRadius: 20, overflow: 'hidden', backgroundColor: '#10261A' }}>
          <ExpoImage source={flowAssets.heroPoster} style={StyleSheet.absoluteFill} contentFit="cover" />
          <LinearGradient colors={['rgba(16,38,26,0.1)', 'rgba(10,10,15,0.55)']} style={StyleSheet.absoluteFill} />
          <View style={StyleSheet.absoluteFill}>
            <TracerArc width={arcW} height={arcH} replayKey={replay} />
          </View>
        </View>
      </Pressable>
      <Rise delay={500} style={{ alignItems: 'center', marginTop: 12 }}>
        <Text style={styles.statCaption}>Tap to replay the trace</Text>
      </Rise>
    </ValueShell>
  );
}

/* ════════════════════ 6. VALUE: SHARE ════════════════════ */
export function ValueShare({ onPrimary }: ScreenProps) {
  const reactions = ['😂', '🔥', '👏'];
  return (
    <ValueShell
      title="The group chat won't recover."
      sub="One tap sends your reel — scorecard overlay and all — straight to the mates."
      onNext={onPrimary}
      ctaLabel="I want this"
    >
      <View style={{ alignItems: 'center', marginTop: 8 }}>
        <Rise delay={150}>
          <View style={{ width: SCREEN_W * 0.5, height: SCREEN_W * 0.78, borderRadius: 18, overflow: 'hidden', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder }}>
            <ExpoImage source={flowAssets.heroPoster} style={StyleSheet.absoluteFill} contentFit="cover" />
            <LinearGradient colors={['transparent', 'rgba(10,10,15,0.7)']} style={StyleSheet.absoluteFill} />
            <View style={{ position: 'absolute', bottom: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} color={theme.colors.primary} />
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Your Round · 0:42</Text>
            </View>
          </View>
        </Rise>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          {reactions.map((r, i) => (
            <ReactionBubble key={i} emoji={r} delay={600 + i * 220} />
          ))}
        </View>
      </View>
    </ValueShell>
  );
}

function ReactionBubble({ emoji, delay }: { emoji: string; delay: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withSequence(withTiming(1.25, { duration: 160 }), withTiming(1, { duration: 140 })));
    const t = setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), delay);
    return () => clearTimeout(t);
  }, [delay, v]);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: v.value }], opacity: v.value === 0 ? 0 : 1 }));
  return (
    <Animated.View style={[a, { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.surfaceElevated, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.surfaceBorder }]}>
      <Text style={{ fontSize: 22 }}>{emoji}</Text>
    </Animated.View>
  );
}

/* ════════════════════ 7. BUILDING LOADER ════════════════════ */
export function BuildingLoader({ onNext }: ScreenProps) {
  const lines = ['Calibrating swing detection', 'Tuning the tracer to your tempo', 'Syncing the scorecard overlay'];
  const [done, setDone] = useState<number>(-1);
  const spin = useSharedValue(0);

  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1);
    const timers = lines.map((_, i) =>
      setTimeout(() => {
        setDone(i);
        Haptics.selectionAsync();
        if (i === lines.length - 1) {
          setTimeout(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onNext();
          }, 600);
        }
      }, 700 + i * 700)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ring = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 28 }}>
      <Animated.View style={[ring, { width: 64, height: 64, borderRadius: 32, borderWidth: 4, borderColor: theme.colors.surfaceBorder, borderTopColor: theme.colors.primary }]} />
      <H1>Building your highlight engine…</H1>
      <View style={{ gap: 14, alignSelf: 'stretch', paddingHorizontal: 12 }}>
        {lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: done >= i ? theme.colors.primary : theme.colors.surfaceElevated }}>
              {done >= i ? <Check size={14} color="#fff" /> : null}
            </View>
            <Text style={{ color: done >= i ? theme.colors.textPrimary : theme.colors.textTertiary, fontSize: 15, fontWeight: '600' }}>{l}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ════════════════════ 8. PROOF WALL ════════════════════ */
export function ProofWall({ onNext }: ScreenProps) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 16 }} showsVerticalScrollIndicator={false}>
        <Rise delay={60} style={{ alignItems: 'center', gap: 10, marginTop: 8 }}>
          <StarRating value={5} size={28} />
          <Text style={styles.proofRating}>{proofStats.rating} ★ · {proofStats.ratingCount} ratings · App Store</Text>
        </Rise>
        <Rise delay={200}><H1 >Trusted by {proofStats.golfers} Aussie golfers.</H1></Rise>
        <Rise delay={280} style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4 }}>
          <View style={styles.ribbon}><Text style={styles.ribbonText}>{proofStats.roundsCaptured} rounds captured</Text></View>
          <View style={styles.ribbon}><Text style={styles.ribbonText}>As seen on Instagram</Text></View>
        </Rise>
        <View style={{ gap: 12, marginTop: 24 }}>
          {testimonials.slice(0, 5).map((t, i) => (
            <Rise key={t.handle} delay={360 + i * 80}>
              <View style={styles.reviewCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text style={styles.reviewName}>{t.name} <Text style={styles.reviewHandle}>{t.handle}</Text></Text>
                  <StarRating value={t.stars} size={12} animate={false} />
                </View>
                <Text style={styles.reviewQuote}>"{t.quote}"</Text>
              </View>
            </Rise>
          ))}
        </View>
      </ScrollView>
      <View style={{ padding: 24, paddingTop: 8, backgroundColor: theme.colors.background }}>
        <FlowButton label="See my plan" onPress={onNext} />
      </View>
    </View>
  );
}

/* ════════════════════ 9. PAYWALL PREVIEW ════════════════════ */
export function PaywallPreview({ goal, onPrimary, onSecondary }: ScreenProps) {
  const [plan, setPlan] = useState<'annual' | 'monthly'>('annual');
  const recap = goal ? goalRecap[goal] : 'Unlimited highlight reels from every round';
  const features = [
    recap,
    'Shot tracer on every full swing',
    'Unlimited exports & shares',
    'All detection & trim settings',
  ];
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 12 }} showsVerticalScrollIndicator={false}>
        <Rise delay={40} style={{ alignItems: 'center', marginTop: 4 }}>
          <H1>Start filming your rounds.</H1>
          {trialConfig.enabled ? (
            <Sub>7 days free, then A$149/yr (just A$0.41/day). Cancel anytime.</Sub>
          ) : (
            <Sub>Unlimited reels, tracer and exports — A$149/yr.</Sub>
          )}
        </Rise>

        {trialConfig.enabled ? (
          <Rise delay={160} style={{ marginTop: 16 }}>
            <TrialTimeline days={trialConfig.days} reminderBefore={trialConfig.reminderDayBeforeBill} />
          </Rise>
        ) : null}

        <Rise delay={240} style={{ gap: 12, marginTop: 16 }}>
          <PlanCard
            title="Annual"
            price="A$149/yr · just A$0.41/day"
            badge="SAVE 38%"
            active={plan === 'annual'}
            onPress={() => {
              Haptics.selectionAsync();
              setPlan('annual');
            }}
          />
          <PlanCard
            title="Monthly"
            price="A$19.99/mo"
            active={plan === 'monthly'}
            onPress={() => {
              Haptics.selectionAsync();
              setPlan('monthly');
            }}
          />
        </Rise>

        <Rise delay={320} style={{ gap: 10, marginTop: 20 }}>
          {features.map((f) => (
            <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Check size={18} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.textPrimary, fontSize: 15 }}>{f}</Text>
            </View>
          ))}
        </Rise>
      </ScrollView>

      <View style={{ padding: 24, paddingTop: 8, gap: 10 }}>
        <View style={{ alignItems: 'center', marginBottom: 2 }}>
          <TrustStrip />
        </View>
        <Text style={styles.lossAversion}>Your next round is the one you'll wish you'd filmed.</Text>
        <FlowButton label={trialConfig.enabled ? 'Start my free trial' : 'Start filming my rounds'} onPress={onPrimary} />
        <FlowButton label="Maybe later" variant="ghost" onPress={onSecondary} />
      </View>
    </View>
  );
}

function PlanCard({ title, price, badge, active, onPress }: { title: string; price: string; badge?: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <View
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: 2,
          borderColor: active ? theme.colors.primary : theme.colors.surfaceBorder,
          backgroundColor: theme.colors.surfaceElevated,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '800', fontSize: 16 }}>{title}</Text>
            {badge ? (
              <View style={{ backgroundColor: '#F2C14E22', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ color: '#F2C14E', fontSize: 11, fontWeight: '800' }}>{badge}</Text>
              </View>
            ) : null}
          </View>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>{price}</Text>
        </View>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 2,
            borderColor: active ? theme.colors.primary : theme.colors.surfaceBorder,
            backgroundColor: active ? theme.colors.primary : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {active ? <Check size={14} color="#fff" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

/* ── Value-screen shell ───────────────────────────────────────────────── */
function ValueShell({
  title,
  sub,
  onNext,
  ctaLabel = 'Next',
  children,
}: {
  title: string;
  sub: string;
  onNext: () => void;
  ctaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        <Rise delay={40}><H1>{title}</H1></Rise>
        <Rise delay={140} style={{ marginBottom: 24 }}><Sub>{sub}</Sub></Rise>
        <Animated.View entering={FadeIn.delay(220).duration(400)}>{children}</Animated.View>
      </View>
      <View style={{ padding: 24, paddingTop: 8 }}>
        <FlowButton label={ctaLabel} onPress={onNext} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { color: theme.colors.textPrimary, fontSize: 30, fontWeight: '900', lineHeight: 36 },
  sub: { color: theme.colors.textSecondary, fontSize: 16, lineHeight: 22, marginTop: 8 },
  secondaryLink: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  skip: { color: theme.colors.textTertiary, fontSize: 14, fontWeight: '600' },
  statCaption: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 4 },
  clipTag: { position: 'absolute', bottom: 10, left: 10, backgroundColor: 'rgba(10,10,15,0.7)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  clipTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  proofRating: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: '600' },
  ribbon: { backgroundColor: theme.colors.surfaceElevated, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: theme.colors.surfaceBorder },
  ribbonText: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700' },
  reviewCard: { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.lg, padding: 14, borderWidth: 1, borderColor: theme.colors.surfaceBorder },
  reviewName: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: '700' },
  reviewHandle: { color: theme.colors.textTertiary, fontSize: 12, fontWeight: '500' },
  reviewQuote: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 },
  lossAversion: { color: theme.colors.textTertiary, fontSize: 13, textAlign: 'center', fontStyle: 'italic' },
});
