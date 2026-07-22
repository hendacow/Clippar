# App Store submission notes

## 14-day free trial — App Store Connect setup (Free Introductory Offer)

The 14-day trial is granted and enforced entirely by Apple — the app ships
with **zero code changes required** for it to take effect. `lib/iap.ts`
already derives trial copy from the store (`ProOffering.trialDays` from the
package's `introPrice` + per-user eligibility), and entitlement gating reacts
to whatever RevenueCat reports, trial or paid alike.

Exact steps in App Store Connect (repeat for **both** auto-renewing
subscription products — monthly and annual; the lifetime non-consumable
cannot and should not have one):

1. App Store Connect → **My Apps → Clippar → Subscriptions**.
2. Open the **Clippar Pro** subscription group.
3. Select the **monthly** product → **Introductory Offers** → **+** (Create
   Introductory Offer).
4. Countries/Regions: **All countries or regions** → Next.
5. Start date: today (or the launch date); End date: **No end date** → Next.
6. Type: **Free**; Duration: **2 weeks** → Confirm.
7. Repeat steps 3–6 for the **annual** product.
8. Submit the offers with the next app version (offers attach to the
   in-app-purchase review, no new binary needed).

Verification: after the offers are approved, the paywall automatically shows
"14 days free, then …" (RevenueCat surfaces `introPrice`; eligibility is
checked per Apple ID — lapsed subscribers who already used a trial correctly
see plain pricing). Apple starts the trial at purchase confirmation, sends
the pre-renewal notice, and takes the first charge on day 15 unless the user
cancels — none of that is app logic.

## OTA publish safety (dev-unlock foot-gun)

`extra.variant` is evaluated when `eas update` runs, so publishing from a shell
with `APP_VARIANT=development` set would push a dev-variant manifest to
production — which used to risk exposing the dev paywall unlock. Two layers now
prevent this: `isDevVariant()` also requires the native `.dev` bundle id
(un-OTA-able), and the only sanctioned publish commands are
`npm run ota:prod` (strips APP_VARIANT) and `npm run ota:dev`.
**Never run raw `eas update` from a local shell.**
