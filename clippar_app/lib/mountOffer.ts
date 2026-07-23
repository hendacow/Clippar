/**
 * Persistence + gating for the Clippar Mount cross-sell surfaces
 * (feat/mount-upsell). Mirrors lib/salesFlow.ts: a standalone module so the
 * whole feature disconnects cleanly — delete this file, lib/mountOfferLogic,
 * app/mount-offer.tsx, the record-tab card and the resolvePostAuthRoute call
 * sites to revert to stock behavior.
 *
 * Surface 1 — one-time post-signup offer screen (/mount-offer):
 *   Shown exactly once, right after a NEW account is created — never for
 *   returning logins. Two signals feed the decision (see mountOfferLogic):
 *     - `shop.mount_offer_pending`: set locally the moment an email signup
 *       succeeds, so the FIRST login after the email-confirmation round-trip
 *       still shows the offer regardless of how long confirmation took.
 *     - account age (user.created_at within 48h): catches social-auth
 *       signups, which create account + session in one step.
 *   `shop.mount_offer_seen` is written the moment the screen mounts, so it
 *   can never reappear — even if the app is killed mid-offer.
 *
 * Surface 2 — dismissible card on the Record tab chooser:
 *   `shop.mount_card_dismissed` persists the X so the card stays gone.
 */
import { getSetting, setSetting } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { shouldShowMountOffer } from '@/lib/mountOfferLogic';

const SEEN_KEY = 'shop.mount_offer_seen';
const PENDING_KEY = 'shop.mount_offer_pending';
const CARD_DISMISSED_KEY = 'shop.mount_card_dismissed';

/** Call when an EMAIL signup succeeds (account exists but the session only
 *  arrives after email confirmation + first login). */
export async function markMountOfferPending(): Promise<void> {
  try {
    await setSetting(PENDING_KEY, '1');
  } catch {}
}

/** Call the moment the offer screen mounts — guarantees at-most-once. */
export async function markMountOfferSeen(): Promise<void> {
  try {
    await setSetting(SEEN_KEY, '1');
    await setSetting(PENDING_KEY, '0');
  } catch {}
}

/**
 * Where a successful auth (signup OR login) should land: the one-time mount
 * offer for brand-new accounts, the tabs for everyone else. Pass the user
 * when the caller has it (root auth gate); with no argument the current
 * session's user is read locally (social-auth callbacks fire before the
 * useAuth state has propagated). Fail-open to the tabs — a storage or
 * session hiccup must never block getting into the app.
 */
export async function resolvePostAuthRoute(
  user?: { created_at?: string } | null
): Promise<'/mount-offer' | '/(tabs)'> {
  try {
    let u = user;
    if (!u) {
      const { data } = await supabase.auth.getSession();
      u = data.session?.user ?? null;
    }
    const [seen, pending] = await Promise.all([
      getSetting(SEEN_KEY),
      getSetting(PENDING_KEY),
    ]);
    const show = shouldShowMountOffer({
      seen: seen === '1',
      pending: pending === '1',
      createdAt: u?.created_at ?? null,
      nowMs: Date.now(),
    });
    return show ? '/mount-offer' : '/(tabs)';
  } catch {
    return '/(tabs)';
  }
}

// ── Surface 2: Record-tab card ──────────────────────────────────────────

export async function getMountCardDismissed(): Promise<boolean> {
  try {
    return (await getSetting(CARD_DISMISSED_KEY)) === '1';
  } catch {
    // On a storage hiccup, hide the card — never risk it nagging forever.
    return true;
  }
}

export async function dismissMountCard(): Promise<void> {
  try {
    await setSetting(CARD_DISMISSED_KEY, '1');
  } catch {}
}
