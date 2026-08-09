/**
 * Product-analytics client (PostHog) for the funnel: app_opened → signed_up →
 * round_started → reel_created → paywall_viewed → subscription_started.
 *
 * Design notes:
 *  - KEYS STAY SERVER-SIDE. The client never holds the PostHog project key.
 *    Events are POSTed (keyless) to the `ingest-analytics` Supabase Edge
 *    Function, which injects POSTHOG_API_KEY (a Supabase secret) and forwards
 *    to PostHog. So nothing analytics-secret ships in the bundle — same posture
 *    as process-round / create-share-link for the other secrets.
 *  - PURE JS, NO NATIVE MODULE. Unlike posthog-react-native, this needs no
 *    config plugin / rebuild — it's verifiable at Tier 1 (verify + Expo Web).
 *  - BEST-EFFORT. Every path is fire-and-forget and swallows errors; analytics
 *    must never break a user flow. Events are batched and flushed on a short
 *    debounce. Failed flushes are dropped (no durable retry) — losing a few
 *    events is fine; blocking the app is not.
 *  - The payload SHAPE lives in lib/analyticsPayload.ts (pure, unit-tested).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';
import {
  ANALYTICS_EVENTS,
  buildCaptureEvent,
  buildIdentifyEvent,
  type AnalyticsEvent,
  type PostHogEvent,
} from '@/lib/analyticsPayload';

export { ANALYTICS_EVENTS };
export type { AnalyticsEvent };

// Anonymous-id storage key. Plain AsyncStorage (not SecureStore) — this is a
// non-sensitive opaque UUID and must be readable in the racey post-launch
// window where the Keychain can throw (see lib/supabase.ts).
const DISTINCT_ID_KEY = 'clippar:analytics:distinct_id';
const FLUSH_DELAY_MS = 800;
const MAX_BATCH = 20;

let distinctId: string | null = null;
let distinctIdLoad: Promise<string> | null = null;
let queue: PostHogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Properties attached to every event so funnels can segment without joins. */
function baseProps(): Record<string, unknown> {
  return {
    $lib: 'clippar-mobile',
    platform: Platform.OS,
    app_variant: (Constants.expoConfig?.extra?.variant as string) ?? 'development',
    app_version: Constants.expoConfig?.version ?? null,
  };
}

/** Lazily load (or mint + persist) the anonymous distinct_id. */
function loadDistinctId(): Promise<string> {
  if (distinctId) return Promise.resolve(distinctId);
  if (!distinctIdLoad) {
    distinctIdLoad = (async () => {
      try {
        const stored = await AsyncStorage.getItem(DISTINCT_ID_KEY);
        if (stored) {
          distinctId = stored;
          return stored;
        }
      } catch {
        // fall through to mint a fresh id
      }
      const fresh = Crypto.randomUUID();
      distinctId = fresh;
      try {
        await AsyncStorage.setItem(DISTINCT_ID_KEY, fresh);
      } catch {
        // Couldn't persist — keep the in-memory id for this session.
      }
      return fresh;
    })();
  }
  return distinctIdLoad;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    const { error } = await supabase.functions.invoke('ingest-analytics', {
      body: { batch },
    });
    if (error && __DEV__) console.log('[analytics] flush failed:', error.message);
  } catch (e) {
    if (__DEV__) console.log('[analytics] flush threw:', e);
  }
  // Drain anything that arrived (or overflowed MAX_BATCH) while we were away.
  if (queue.length > 0) scheduleFlush();
}

function enqueue(ev: PostHogEvent): void {
  queue.push(ev);
  if (queue.length >= MAX_BATCH) void flush();
  else scheduleFlush();
}

/** Track a funnel event. Never throws. */
export async function capture(
  event: AnalyticsEvent | string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (!config.analytics.enabled) return;
  try {
    const id = await loadDistinctId();
    enqueue(buildCaptureEvent(event, id, properties, baseProps(), new Date().toISOString()));
  } catch (e) {
    if (__DEV__) console.log('[analytics] capture error:', e);
  }
}

/**
 * Tie subsequent events to the authenticated user and merge the anonymous
 * pre-signup profile into theirs. Safe to call on every session restore.
 */
export async function identify(
  userId: string,
  setProps?: Record<string, unknown>,
): Promise<void> {
  if (!config.analytics.enabled) return;
  try {
    const anon = await loadDistinctId();
    enqueue(buildIdentifyEvent(userId, anon, setProps, baseProps(), new Date().toISOString()));
    // Attribute later events to the user id and persist it as the distinct id.
    distinctId = userId;
    try {
      await AsyncStorage.setItem(DISTINCT_ID_KEY, userId);
    } catch {
      // best-effort
    }
  } catch (e) {
    if (__DEV__) console.log('[analytics] identify error:', e);
  }
}

/** On sign-out: flush, then forget identity so the next session is anonymous. */
export async function reset(): Promise<void> {
  try {
    await flush();
  } catch {
    // ignore
  }
  distinctId = null;
  distinctIdLoad = null;
  try {
    await AsyncStorage.removeItem(DISTINCT_ID_KEY);
  } catch {
    // ignore
  }
}

export const analytics = { capture, identify, reset };
