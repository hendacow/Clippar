/**
 * Pure, dependency-free helpers for building PostHog-shaped event payloads.
 *
 * Deliberately imports nothing from react-native / expo / supabase so it can
 * be unit-tested headlessly with `tsx` (like lib/tracerMath.ts). All the
 * runtime plumbing — distinct_id storage, batching, transport — lives in
 * lib/analytics.ts and calls into these builders.
 *
 * The shape matches PostHog's batch ingestion API: each item is
 *   { event, properties: { distinct_id, ... }, timestamp }
 * and the project API key is added server-side by the ingest-analytics Edge
 * Function — never here, never in the client bundle.
 */

/** Canonical funnel event names. One source of truth for call sites + tests. */
export const ANALYTICS_EVENTS = {
  APP_OPENED: 'app_opened',
  SIGNED_UP: 'signed_up',
  ROUND_STARTED: 'round_started',
  REEL_CREATED: 'reel_created',
  PAYWALL_VIEWED: 'paywall_viewed',
  SUBSCRIPTION_STARTED: 'subscription_started',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

export interface PostHogEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/**
 * Build a standard capture event. `distinct_id` is written LAST so neither the
 * base props nor a caller's custom properties can clobber the identity.
 */
export function buildCaptureEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> | undefined,
  baseProps: Record<string, unknown>,
  timestamp: string,
): PostHogEvent {
  return {
    event,
    properties: {
      ...baseProps,
      ...(properties ?? {}),
      distinct_id: distinctId,
    },
    timestamp,
  };
}

/**
 * Build a `$identify` event that aliases the anonymous distinct_id to the
 * authenticated user id, so the pre-signup funnel (app_opened, paywall_viewed)
 * stitches onto the same person once they sign in. `$anon_distinct_id` is only
 * set when it actually differs from the user id, which is what tells PostHog to
 * merge the two profiles.
 */
export function buildIdentifyEvent(
  distinctId: string,
  anonDistinctId: string | null,
  setProps: Record<string, unknown> | undefined,
  baseProps: Record<string, unknown>,
  timestamp: string,
): PostHogEvent {
  const properties: Record<string, unknown> = {
    ...baseProps,
    distinct_id: distinctId,
    $set: setProps ?? {},
  };
  if (anonDistinctId && anonDistinctId !== distinctId) {
    properties.$anon_distinct_id = anonDistinctId;
  }
  return { event: '$identify', properties, timestamp };
}
