# Clippar Pro — In-App Purchase setup (App Store + RevenueCat)

This is the **manual dashboard checklist** for taking the digital subscription
(Clippar Pro) live via Apple In-App Purchase through RevenueCat. The app code is
already done — it degrades to a priced-but-unbuyable stub until the keys/products
below exist, so nothing here blocks a build.

**Why this exists:** App Store Guideline **3.1.1** requires that anything which
unlocks features inside the app be sold via StoreKit IAP, never an external web
link. The old "Subscribe at clippargolf.com" flow was an automatic rejection.
(The physical mount/clicker in the Shop tab stays on Stripe — Apple *requires*
physical goods to NOT use IAP. Don't move that.)

---

## How the pieces fit

```
 App (lib/iap.ts, app/paywall.tsx)
   │  Purchases.configure(EXPO_PUBLIC_RC_IOS_KEY)   ← public key, ships in client
   │  Purchases.logIn(<supabase user id>)           ← so RC app_user_id == UUID
   │  getOfferings() / purchasePackage() / restorePurchases()
   ▼
 RevenueCat  ── entitlement "Clippar Pro" ──▶ webhook
   │                                              │  Authorization: <shared secret>
   ▼                                              ▼
 App Store Connect (products)            supabase/functions/revenuecat-webhook
                                              │  upserts profiles.subscription_status
                                              ▼  + subscription_expires_at
                                          Supabase  ← source of truth lib/subscription.ts reads
```

Source of truth for *access* stays `profiles.subscription_status` /
`subscription_expires_at` in Supabase. RevenueCat owns *purchases* and pushes
state into those columns via the webhook. The client also reads the live RC
entitlement directly (`iap.isProActive()`) for instant unlock after purchase.

---

## Checklist

### 1. App Store Connect — create the products

In **App Store Connect → your app → Monetization → Subscriptions**:

- [ ] Create a **Subscription Group** (e.g. `Clippar Pro`).
- [ ] Add **Monthly** auto-renewable subscription — suggested product id
      `com.clippar.app.pro.monthly`, price **A$19.99**.
- [ ] Add **Annual** auto-renewable subscription — suggested product id
      `com.clippar.app.pro.annual`, price **A$149.00**.
- [ ] (Optional, only if you want a Lifetime tile) a **non-consumable**
      `com.clippar.app.pro.lifetime`. The paywall renders it automatically if
      RevenueCat returns a `LIFETIME` package; skip it otherwise.
- [ ] Fill each product's localized display name, description, and review
      screenshot (Apple requires these before the product leaves "Missing
      Metadata").
- [ ] **Agreements, Tax, and Banking**: the **Paid Apps agreement** must be
      *Active* or products never return from `getOfferings()`.
- [ ] Create a **Sandbox tester** (Users and Access → Sandbox) to test purchases
      without real charges.

> Product ids are not hard-coded in the app — `lib/iap.ts` maps by RevenueCat
> *package type* (MONTHLY / ANNUAL / LIFETIME), so the exact strings only need to
> match what you link in RevenueCat (step 2).

### 2. RevenueCat — project, products, offering, entitlement

In the **RevenueCat dashboard**:

- [ ] Create (or open) the project and add an **App** of type *App Store* with
      bundle id `com.clippar.app` (and `com.clippar.app.dev` if you want a
      separate dev app).
- [ ] Upload the **App Store Connect API key** (in-app purchase key) so
      RevenueCat can validate receipts and read product metadata.
- [ ] Create an **Entitlement** with identifier exactly **`Clippar Pro`**
      (must match `config.subscription.entitlementId`).
- [ ] Import the products from step 1 and **attach each to the `Clippar Pro`
      entitlement**.
- [ ] Create the **default Offering** (the code reads `offerings.current`) and
      add packages: **Monthly**, **Annual**, and **Lifetime** if used. Use the
      standard package types so they map to our plan vocabulary.
- [ ] Copy the **public iOS SDK key** (starts with `appl_`) from
      **Project → API keys**.

### 3. Wire the public key into the app

- [ ] Set **`EXPO_PUBLIC_RC_IOS_KEY`** = the `appl_…` key.
  - Local: add to `.env.development.local` (see `.env.development.local.example`).
  - EAS builds: add it to the EAS environment variables for each build profile
    at <https://expo.dev/accounts/clippar/projects/clippar/environment-variables>.
  - Legacy alias `EXPO_PUBLIC_REVENUECAT_IOS_KEY` is still read if present.
- [ ] **Rebuild the dev client / EAS build.** `react-native-purchases` is a
      native module — a Metro reload is NOT enough; an existing build without it
      will keep using the stub. (Expo Go always uses the stub.)

### 4. Deploy the webhook Edge Function

The function `supabase/functions/revenuecat-webhook` projects RevenueCat events
onto `profiles.subscription_status` + `subscription_expires_at`.

- [ ] Choose a strong random string for the shared secret (the webhook
      `Authorization` value), e.g. `openssl rand -hex 32`.
- [ ] Set the function secrets (no quotes needed):
      ```
      supabase secrets set REVENUECAT_WEBHOOK_AUTH=<that random string>
      # REVENUECAT_SECRET_KEY is optional — only used by delete-account to
      # remove the RC subscriber on account deletion (the `sk_`/v1 secret key).
      supabase secrets set REVENUECAT_SECRET_KEY=<revenuecat v1 secret key>
      ```
      (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
- [ ] Deploy **without JWT verification** — RevenueCat does not send a Supabase
      JWT; the shared secret is the auth:
      ```
      supabase functions deploy revenuecat-webhook --no-verify-jwt
      ```
- [ ] Grab the function URL:
      `https://<project-ref>.functions.supabase.co/revenuecat-webhook`

### 5. RevenueCat — register the webhook

In **RevenueCat → Project → Integrations → Webhooks**:

- [ ] **URL** = the function URL from step 4.
- [ ] **Authorization header** = the *same* random string you set as
      `REVENUECAT_WEBHOOK_AUTH`. (RevenueCat sends this verbatim; the function
      string-compares it.)
- [ ] Send a **test event** — it should return `200 {"received":true,...}`.
      A `TEST` event is intentionally acked-and-skipped (no DB write).

### 6. End-to-end verification

- [ ] On a **physical device** with the rebuilt dev client, sign in, open the
      paywall (Profile → upgrade, or trigger the export gate), and buy with the
      **sandbox tester**.
- [ ] Confirm Pro unlocks immediately (optimistic refresh via the live RC
      entitlement).
- [ ] In Supabase, confirm the user's `profiles.subscription_status = 'active'`
      and `subscription_expires_at` is set (webhook path).
- [ ] Tap **Restore Purchases** on a fresh install / reinstall and confirm it
      re-grants.
- [ ] (Optional) In RevenueCat sandbox, force a renewal/expiration and confirm
      the columns update from the webhook.

### 7. Go to production

- [ ] Swap `EXPO_PUBLIC_RC_IOS_KEY` to the **production** `appl_` key if you use
      a separate prod RevenueCat app (often the same key works for both).
- [ ] Flip the export gate when you're ready to actually require a subscription:
      `config.subscription.enforceExportGate = true` in `constants/config.ts`
      (currently **OFF** so nobody is locked out before purchases exist).
- [ ] Submit the build with the IAP products attached for review.

---

## Env var reference

| Name | Where | Secret? | Purpose |
|---|---|---|---|
| `EXPO_PUBLIC_RC_IOS_KEY` | client (.env / EAS) | public (`appl_`) | RevenueCat iOS SDK key |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY` | client | public | legacy alias for the above |
| `REVENUECAT_WEBHOOK_AUTH` | Supabase function secret | **yes** | shared secret the webhook checks |
| `REVENUECAT_SECRET_KEY` | Supabase function secret | **yes** | RC v1 secret key, used by delete-account only |

## Open TODOs (need Henry's dashboard access)

- [ ] Create the App Store Connect products + Paid Apps agreement (step 1).
- [ ] Create the RevenueCat project/entitlement/offering and copy the public key
      (step 2–3).
- [ ] Set the two Supabase secrets and deploy the webhook (step 4–5).

Until those are done the app ships safely with the stub: the paywall shows
prices, "Continue" explains Pro arrives with the App Store release, and the
`Clippar Pro` entitlement is simply never active.

## Android (later — config change, not a rewrite)

The `lib/iap.ts` provider seam already abstracts the store. To add Google Play
Billing: create the products in Play Console, add an *Android* app + entitlement
mapping in the same RevenueCat project, add `EXPO_PUBLIC_RC_ANDROID_KEY` (the
`goog_` key) and a `Platform.select` in `config.subscription.revenueCatIosKey`'s
resolution. No paywall/UI changes needed; the same webhook handles both stores.
