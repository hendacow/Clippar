/**
 * In-app purchase abstraction for Clippar Pro.
 *
 * App Review 3.1.1: in Australia the subscription MUST be purchasable via
 * StoreKit In-App Purchase — never a link to Stripe checkout. This module is
 * the seam where RevenueCat drops in:
 *
 *   1. Create the subscription group + products in App Store Connect:
 *        com.clippar.app.pro.monthly  (A$19.99 / month)
 *        com.clippar.app.pro.annual   (A$149 / year)
 *   2. `npx expo install react-native-purchases` and add the RevenueCat
 *      public API key below (EXPO_PUBLIC_REVENUECAT_IOS_KEY).
 *   3. Replace StubProvider with the RevenueCat-backed implementation
 *      (purchase → entitlement "pro" → webhook updates
 *      profiles.subscription_status server-side).
 *
 * Until then the stub keeps every call site compiling and testable: it
 * reports IAP as unavailable and purchases reject with a friendly error.
 */
import { config } from '@/constants/config';

export type ProPlan = 'monthly' | 'annual';

export interface ProOffering {
  plan: ProPlan;
  /** Localized display price, e.g. "A$19.99". Stub uses config AUD cents. */
  priceLabel: string;
  periodLabel: string;
  /** Savings hook for the annual card, e.g. "Save 38%". */
  badge?: string;
}

export interface IapProvider {
  /** False when the store layer isn't configured (stub / simulator). */
  isAvailable(): boolean;
  getOfferings(): Promise<ProOffering[]>;
  /** Resolves when the purchase succeeds AND the entitlement is active. */
  purchase(plan: ProPlan): Promise<void>;
  /** Restore previous purchases (required UI affordance on every paywall). */
  restore(): Promise<boolean>;
}

const aud = (cents: number) => `A$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

const StubProvider: IapProvider = {
  isAvailable: () => false,
  async getOfferings() {
    const monthly = config.subscription.monthlyPriceAud;
    const annual = config.subscription.annualPriceAud;
    const savings = Math.round((1 - annual / (monthly * 12)) * 100);
    return [
      { plan: 'monthly', priceLabel: aud(monthly), periodLabel: 'per month' },
      {
        plan: 'annual',
        priceLabel: aud(annual),
        periodLabel: 'per year',
        badge: `Save ${savings}%`,
      },
    ];
  },
  async purchase() {
    throw new Error(
      'Purchases are not available in this build yet — Clippar Pro arrives with the App Store release.'
    );
  },
  async restore() {
    return false;
  },
};

// RevenueCat slot: when react-native-purchases is installed and the key is
// set, swap the export. Kept as a single assignment so call sites never know.
export const iap: IapProvider = StubProvider;
