/**
 * In-app purchase layer for Clippar Pro — RevenueCat-backed.
 *
 * App Review 3.1.1: in Australia the subscription MUST be purchasable via
 * StoreKit In-App Purchase — never a link to Stripe checkout.
 *
 * Architecture:
 *  - `react-native-purchases` is REQUIRED LAZILY. On binaries without the
 *    native module (Expo Go, dev clients built before this commit) or when
 *    no API key is configured, everything falls back to a stub that reports
 *    IAP unavailable — no crash, paywall still renders priced cards.
 *  - Entitlement: "Clippar Pro" (config.subscription.entitlementId). An
 *    active entitlement = Pro, regardless of which product granted it.
 *  - Offerings come from the RevenueCat "default" offering with packages
 *    monthly / yearly (annual) / lifetime.
 *  - RevenueCat appUserID is aliased to the Supabase user id via logIn() so
 *    web (Stripe) and app (StoreKit) subscriptions can unify later.
 *
 * Production checklist (currently using the Test Store key):
 *  1. App Store Connect: create the subscription group + products and the
 *     lifetime non-consumable; link them in RevenueCat.
 *  2. Swap EXPO_PUBLIC_REVENUECAT_IOS_KEY for the appl_... production key.
 *  3. Rebuild the dev client / EAS build (native module).
 */
import { NativeModules, Platform } from 'react-native';
import { config } from '@/constants/config';
import { emitSubscriptionChanged } from '@/lib/subscriptionEvents';
import { isDevVariant } from '@/lib/devPro';

export type ProPlan = 'monthly' | 'annual' | 'lifetime';

export interface ProOffering {
  plan: ProPlan;
  /** Store-localized display price (stub: config AUD prices). */
  priceLabel: string;
  periodLabel: string;
  /** Savings hook for the annual card, e.g. "Save 38%". */
  badge?: string;
  /**
   * Length of the FREE introductory trial in days, present ONLY when the
   * store reports a free intro offer on this package AND the user is not
   * known-ineligible for it. The paywall must never claim a trial unless
   * this is set — a hardcoded "N days free" against a package with no
   * intro offer (or a lapsed subscriber) charges the user immediately,
   * which is both an App Review 3.1.2 problem and real-money harm.
   * Stub offerings never set it (placeholder prices ⇒ no trial claims).
   */
  trialDays?: number;
}

export interface IapProvider {
  /** False when the store layer isn't configured (stub / old binary). */
  isAvailable(): boolean;
  getOfferings(): Promise<ProOffering[]>;
  /** Resolves when the purchase succeeds AND the entitlement is active. */
  purchase(plan: ProPlan): Promise<void>;
  /** Restore previous purchases (required UI affordance on every paywall). */
  restore(): Promise<boolean>;
  /** Live entitlement check ("Clippar Pro"). False on stub. */
  isProActive(): Promise<boolean>;
  /** Tie the RevenueCat customer to the Supabase user id. No-op on stub. */
  identify(userId: string): Promise<void>;
  /** Reset to an anonymous RevenueCat customer (on sign-out / deletion). */
  reset(): Promise<void>;
  /**
   * An auto-renewing App Store subscription is currently active for this
   * Apple ID. Distinct from isProActive() (which also true for lifetime /
   * web subs) — used to warn that account deletion does NOT stop Apple
   * billing, which only the user can do in iOS Settings. False on stub.
   */
  hasActiveStoreSubscription(): Promise<boolean>;
}

const aud = (cents: number) => `A$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

// ─── Stub (Expo Go / unconfigured) ───

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
      isDevVariant()
        ? 'Purchases are not available in the dev build — no App Store products exist for com.clippar.app.dev. Use "Dev: unlock Pro" below to test Pro features.'
        : 'Purchases are not available in this build yet — Clippar Pro arrives with the App Store release.'
    );
  },
  async restore() {
    return false;
  },
  async isProActive() {
    return false;
  },
  async identify() {},
  async reset() {},
  async hasActiveStoreSubscription() {
    return false;
  },
};

// ─── RevenueCat ───

// Lazy module handle. `null` = not yet attempted, `false` = unavailable.
let PurchasesModule: typeof import('react-native-purchases') | false | null = null;
let configured = false;

function loadPurchases(): typeof import('react-native-purchases') | false {
  if (PurchasesModule !== null) return PurchasesModule;
  // FIELD BUG: the JS package imports fine on binaries WITHOUT the native
  // module (old dev client / Expo Go) and only explodes later at
  // configure() — so probe the native side directly, not the require().
  if (!NativeModules.RNPurchases) {
    PurchasesModule = false;
    return false;
  }
  try {
    PurchasesModule = require('react-native-purchases') as typeof import('react-native-purchases');
  } catch {
    PurchasesModule = false;
  }
  return PurchasesModule ?? false;
}

function getConfiguredPurchases() {
  const mod = loadPurchases();
  if (!mod || Platform.OS !== 'ios' || !config.subscription.revenueCatIosKey) {
    return null;
  }
  const Purchases = mod.default;
  if (!configured) {
    try {
      Purchases.configure({ apiKey: config.subscription.revenueCatIosKey });
      configured = true;
      // Entitlement push channel: RevenueCat fires this on purchase, restore,
      // renewal, billing lapse and (on app foreground) refreshed customerInfo.
      // Re-broadcast on our in-process bus so every mounted useSubscription()
      // re-runs getProStatus() — this is how trial expiry / cancellation
      // re-locks gated features on the next refresh instead of mid-session.
      try {
        Purchases.addCustomerInfoUpdateListener(() => emitSubscriptionChanged());
      } catch {
        // Listener wiring is best-effort; polling refreshes still cover us.
      }
    } catch {
      // Belt-and-braces: any configure failure downgrades to the stub
      // rather than surfacing store errors into UI flows.
      PurchasesModule = false;
      return null;
    }
  }
  return Purchases;
}

/** RevenueCat package → our plan vocabulary. */
const PLAN_BY_PACKAGE_TYPE: Record<string, ProPlan> = {
  MONTHLY: 'monthly',
  ANNUAL: 'annual',
  LIFETIME: 'lifetime',
};

const PERIOD_LABEL: Record<ProPlan, string> = {
  monthly: 'per month',
  annual: 'per year',
  lifetime: 'one-time',
};

type RcPackage = import('react-native-purchases').PurchasesPackage;

async function getDefaultPackages(): Promise<RcPackage[]> {
  const Purchases = getConfiguredPurchases();
  if (!Purchases) return [];
  const offerings = await Purchases.getOfferings();
  return offerings.current?.availablePackages ?? [];
}

function packagePlan(pkg: RcPackage): ProPlan | null {
  return PLAN_BY_PACKAGE_TYPE[String(pkg.packageType)] ?? null;
}

/**
 * Days of FREE trial the store reports on a package, or null when there is
 * no intro offer / the intro offer is paid (pay-up-front / pay-as-you-go).
 */
function introTrialDays(pkg: RcPackage): number | null {
  const intro = pkg.product.introPrice;
  if (!intro || intro.price !== 0) return null;
  const units = intro.periodNumberOfUnits * Math.max(1, intro.cycles);
  switch (intro.periodUnit) {
    case 'DAY':
      return units;
    case 'WEEK':
      return units * 7;
    case 'MONTH':
      return units * 30;
    case 'YEAR':
      return units * 365;
    default:
      return null;
  }
}

// react-native-purchases INTRO_ELIGIBILITY_STATUS values we must exclude.
// 1 = INELIGIBLE (e.g. lapsed subscriber who already used the trial),
// 3 = NO_INTRO_OFFER_EXISTS. 0 = UNKNOWN and 2 = ELIGIBLE both allow the
// trial claim — StoreKit's own purchase sheet remains the source of truth
// at confirmation time.
const INTRO_STATUS_INELIGIBLE = 1;
const INTRO_STATUS_NO_OFFER = 3;

async function introEligibilityByProduct(
  packages: RcPackage[]
): Promise<Record<string, number | undefined>> {
  const Purchases = getConfiguredPurchases();
  if (!Purchases) return {};
  try {
    const checker = (Purchases as unknown as {
      checkTrialOrIntroductoryPriceEligibility?: (
        ids: string[]
      ) => Promise<Record<string, { status: number }>>;
    }).checkTrialOrIntroductoryPriceEligibility;
    if (!checker) return {};
    const result = await checker(packages.map((p) => p.product.identifier));
    const out: Record<string, number | undefined> = {};
    for (const [id, v] of Object.entries(result ?? {})) out[id] = v?.status;
    return out;
  } catch {
    // Eligibility check is best-effort; introPrice presence still gates.
    return {};
  }
}

const RevenueCatProvider: IapProvider = {
  isAvailable() {
    return getConfiguredPurchases() !== null;
  },

  async getOfferings(): Promise<ProOffering[]> {
    const packages = await getDefaultPackages();
    if (packages.length === 0) return StubProvider.getOfferings();

    const eligibility = await introEligibilityByProduct(packages);
    const monthly = packages.find((p) => packagePlan(p) === 'monthly');
    const offerings: ProOffering[] = [];
    for (const pkg of packages) {
      const plan = packagePlan(pkg);
      if (!plan) continue;
      let badge: string | undefined;
      if (plan === 'annual' && monthly) {
        const saving = Math.round(
          (1 - pkg.product.price / (monthly.product.price * 12)) * 100
        );
        if (saving > 0) badge = `Save ${saving}%`;
      }
      if (plan === 'lifetime') badge = 'Forever';
      const days = introTrialDays(pkg);
      const status = eligibility[pkg.product.identifier];
      const trialDays =
        days != null &&
        status !== INTRO_STATUS_INELIGIBLE &&
        status !== INTRO_STATUS_NO_OFFER
          ? days
          : undefined;
      offerings.push({
        plan,
        priceLabel: pkg.product.priceString,
        periodLabel: PERIOD_LABEL[plan],
        badge,
        trialDays,
      });
    }
    // Stable display order: monthly, annual, lifetime.
    const order: ProPlan[] = ['monthly', 'annual', 'lifetime'];
    offerings.sort((a, b) => order.indexOf(a.plan) - order.indexOf(b.plan));
    return offerings;
  },

  async purchase(plan: ProPlan): Promise<void> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return StubProvider.purchase(plan);

    const packages = await getDefaultPackages();
    const pkg = packages.find((p) => packagePlan(p) === plan);
    if (!pkg) {
      // Dev builds ("Clippar Dev", com.clippar.app.dev) have no App Store
      // products, so this path is EXPECTED there — point at the dev unlock
      // instead of a dead-end store error.
      throw new Error(
        isDevVariant()
          ? 'No store products exist for the dev build (com.clippar.app.dev), so purchases can\'t work here. Use "Dev: unlock Pro" below to test Pro features.'
          : 'That plan is not available right now. Please try again later.'
      );
    }

    const mod = loadPurchases();
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      if (!customerInfo.entitlements.active[config.subscription.entitlementId]) {
        throw new Error('Purchase completed but Pro did not activate — try Restore Purchases.');
      }
    } catch (err: unknown) {
      // User-cancelled is a normal outcome, not an error dialog.
      if (
        mod &&
        typeof err === 'object' &&
        err !== null &&
        (err as { userCancelled?: boolean }).userCancelled
      ) {
        throw new Error('Purchase cancelled.');
      }
      if (isDevVariant()) {
        // Any real store failure in the dev variant traces back to the same
        // root cause: the dev bundle ID has no products/StoreKit config.
        const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
        throw new Error(
          `The store purchase failed in the dev build${detail}. Dev builds can't complete real purchases — use "Dev: unlock Pro" below to test Pro features.`
        );
      }
      throw err;
    }
  },

  async restore(): Promise<boolean> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return false;
    const customerInfo = await Purchases.restorePurchases();
    return Boolean(customerInfo.entitlements.active[config.subscription.entitlementId]);
  },

  async isProActive(): Promise<boolean> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return false;
    try {
      const customerInfo = await Purchases.getCustomerInfo();
      return Boolean(customerInfo.entitlements.active[config.subscription.entitlementId]);
    } catch {
      return false;
    }
  },

  async identify(userId: string): Promise<void> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return;
    try {
      await Purchases.logIn(userId);
    } catch {
      // Identity aliasing is best-effort — purchases still work anonymous.
    }
  },

  async reset(): Promise<void> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return;
    try {
      await Purchases.logOut();
    } catch {
      // Already anonymous, or no native module — nothing to unwind.
    }
  },

  async hasActiveStoreSubscription(): Promise<boolean> {
    const Purchases = getConfiguredPurchases();
    if (!Purchases) return false;
    try {
      const customerInfo = await Purchases.getCustomerInfo();
      // activeSubscriptions = product ids of auto-renewing subs only
      // (excludes lifetime non-consumables, which need no cancellation).
      return (customerInfo.activeSubscriptions?.length ?? 0) > 0;
    } catch {
      return false;
    }
  },
};

/**
 * The active provider: RevenueCat when the native module + key exist,
 * otherwise the stub. Resolved per-call (isAvailable) so a single binary
 * works in both worlds.
 */
export const iap: IapProvider = {
  isAvailable: () => RevenueCatProvider.isAvailable(),
  getOfferings: () =>
    RevenueCatProvider.isAvailable()
      ? RevenueCatProvider.getOfferings()
      : StubProvider.getOfferings(),
  purchase: (plan) =>
    RevenueCatProvider.isAvailable()
      ? RevenueCatProvider.purchase(plan)
      : StubProvider.purchase(plan),
  restore: () =>
    RevenueCatProvider.isAvailable() ? RevenueCatProvider.restore() : StubProvider.restore(),
  isProActive: () =>
    RevenueCatProvider.isAvailable()
      ? RevenueCatProvider.isProActive()
      : StubProvider.isProActive(),
  identify: (userId) =>
    RevenueCatProvider.isAvailable()
      ? RevenueCatProvider.identify(userId)
      : StubProvider.identify(userId),
  reset: () =>
    RevenueCatProvider.isAvailable() ? RevenueCatProvider.reset() : StubProvider.reset(),
  hasActiveStoreSubscription: () =>
    RevenueCatProvider.isAvailable()
      ? RevenueCatProvider.hasActiveStoreSubscription()
      : StubProvider.hasActiveStoreSubscription(),
};
