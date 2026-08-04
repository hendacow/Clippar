# Clippar — Legal Risk Register

**Date:** 4 August 2026
**Scope:** Clippar iOS app, clippargolf.com, and the Clippar Mount Kit (phone mount + Bluetooth clicker + portable lithium-ion power bank, A$99).
**Prepared from:** direct reading of the `clippar-codes` repository at commit-time state, plus primary-source legal research (URLs cited inline).

---

## Read this first

**I am not a lawyer and this is not legal advice.** What follows is a well-researched draft and a risk register to take *to* an Australian lawyer. You asked for protection from legal harm. The honest answer is that good documents reduce exposure but do not eliminate it, and for the hardware side a human review is not optional — you are proposing to sell a lithium-ion battery to consumers, and no wording on a web page changes what happens if one of them catches fire.

The rest of this document states things plainly and once. It does not re-hedge every sentence.

**The single most important structural fact in this register:** under Australian Consumer Law s 7, a business that puts its own brand on goods, *or* imports goods whose overseas manufacturer has no Australian place of business, is the **deemed manufacturer** of those goods — not merely a retailer. On the facts as they appear, Clippar will be the deemed manufacturer of the Mount Kit. That means strict liability under ACL Part 3-5 for injury and property damage caused by a safety defect, with no upstream Australian party to pass the claim to.
Source: <https://www.legislation.gov.au/C2004A00109/latest/text> (ACL s 7, ss 138–144).

---

## Severity scale

| Band | Meaning |
|---|---|
| **Catastrophic** | Death, serious injury, or a loss that ends the business and reaches personal assets. |
| **Severe** | Regulator enforcement, six-figure exposure, forced product withdrawal, or App Store removal. |
| **Major** | Civil claims, refunds, penalties in the tens of thousands, reputational damage. |
| **Moderate** | Complaints, corrective action, contract-level disputes. |
| **Low** | Housekeeping; fix because it is cheap, not because it is dangerous. |

Ranked by **consequence**, not by ease of fix. The first four items are of a materially different kind from everything below them. A privacy-policy inaccuracy is a letter from a regulator. A power bank that ignites in a customer's golf bag is a person in a burns unit and an uninsured strict-liability claim against your personal assets. Do not let a long list flatten that difference.

---

# TIER 1 — CATASTROPHIC. Do not ship hardware until these are resolved.

## R1. Lithium-ion power bank causes fire, burns, or property damage
**Severity: Catastrophic · Likelihood: Low per unit, but non-trivial across a product run · Current exposure: Total and uninsured**

**What it is.** The kit includes a portable lithium-ion power bank. Li-ion cells fail by thermal runaway: they vent, ignite, and are very hard to extinguish. The ACCC recorded 231 product-safety incident reports relating to Li-ion batteries between April 2017 and March 2023, and a sixfold increase in media reports 2021–2023 (<https://www.accc.gov.au/system/files/lithium-ion-batteries.pdf>). A golf bag left in a car boot in a Brisbane summer is close to a worst case for thermal abuse.

**The law.**
- **ACL Part 3-5 (ss 138–144)** — strict liability. An injured individual need not prove negligence, only that the goods had a "safety defect" (s 9: safety "not such as persons generally are entitled to expect") and that it caused the harm. Liability extends to a person who suffers loss because of *someone else's* injury (s 139), to damage to other goods (s 140), and to damage to land and buildings (s 141). Actions may be brought up to 10 years after supply (s 143).
- **ACL s 7** — as deemed manufacturer (own brand and/or importer of goods whose maker has no Australian place of business), this liability lands on Clippar directly. The s 274 indemnity from a manufacturer is unavailable unless the actual factory has an Australian presence or a negotiated contractual indemnity exists.
- **ACL s 260** — a safety fault is *automatically* a major failure ("the goods are not of acceptable quality because they are unsafe"), so the customer chooses refund or replacement; you do not get to insist on repair.
- **ACL s 131** — on becoming aware of a death or serious injury or illness that was or may have been caused by use or foreseeable misuse of the goods, you must notify the Commonwealth Minister **in writing within 2 days**. Making the report is not an admission of liability (s 131(6)).
- **ACL s 128** — a voluntary recall must be notified in writing **within 2 days** of taking the action.

**Mitigation — and be clear that documents do not fix this.**
1. **Product liability insurance, in place before the first sale.** Not legally compulsory, but the only thing standing between a claim and personal assets. Get quotes from 2–3 brokers who are told explicitly that the product contains a lithium-ion battery; underwriting appetite and battery-specific exclusions vary and are not standardised (<https://www.steadfast.com.au/well-covered/business-insurance/how-to-manage-the-risks-of-lithium-batteries-for-your-business/>).
2. **Supplier compliance evidence, held on file before the first sale:** UN 38.3 transport test summary, IEC/AS 62133 cell certification, factory identity and address, batch/lot traceability.
3. **A written supplier indemnity** for defect claims — knowing that an indemnity from an overseas factory may be practically unenforceable.
4. **Safety warnings and instructions shipped in the box**, not only on the website — s 9 explicitly weighs "instructions for, or warnings with respect to, doing or refraining from doing anything with or in relation to the goods."
5. **A written incident procedure** that can hit the 2-day s 131 deadline.
6. **A lawyer.** This item is the reason.

**Documents cannot fix this.** Terms can allocate some risk, warn users, and make the ACL position accurate. They cannot exclude Part 3-5, cannot exclude the consumer guarantees, and will not pay a burns claim.

---

## R2. Supplying non-compliant electrical equipment (EESS)
**Severity: Catastrophic · Likelihood: High if unaddressed · Current exposure: Unknown, and that is the problem**

**What it is.** If the kit contains a mains wall charger / plug pack for the power bank, that item is in-scope electrical equipment under the Electrical Equipment Safety System. The official EESS in-scope table classifies "Power supply or charger" — a device with output ≤50 V AC or ≤120 V ripple-free DC used for charging batteries or supplying separate equipment, tested to AS/NZS 60335.2.29 — as **Risk Level 3 (high risk)**. Level 2 and Level 3 equipment **must** be registered on the national EESS database, by a registered Responsible Supplier, with third-party certification, **before supply**.
Sources: <https://www.eess.gov.au/>, <https://www.eess.gov.au/wp-content/uploads/2024/07/EESS-Inscope-Equipment-Definitions-and-Risk-Levels-v4.3-Approved.pdf>, <https://www.eess.gov.au/registration/eess-registration-database/>. Administered in Queensland by the WorkSafe QLD Electrical Safety Office.

**Two things are genuinely unresolved and must be settled by a human:**
- **Does the kit include a mains charger at all, or only a USB-charged power bank?** `clippar-web/public/mount.html` says "portable charger" and nothing more. The repo does not answer this.
- **Is the power bank itself in scope, independently of a mains charger?** The research could not find an explicit EESS determination for a mains-plugless battery pack. The general voltage threshold suggests it may fall outside scope, but that is an inference, not a ruling.

**Mitigation.** Obtain a **written scope determination** from EESS / the Queensland Electrical Safety Office before supply (EESS admin, `eessadmin@oir.qld.gov.au`, 1300 563 492). If in scope at Level 3: register as a Responsible Supplier, obtain certification through a Recognised External Certification Scheme, apply the RCM, and keep the compliance folder. Supplying uncertified Level 3 equipment is not a paperwork problem; it is the fact pattern that turns R1 from "defended claim" into "indefensible claim," and it destroys the s 142(c) compliance-with-mandatory-standard defence.

**Documents cannot fix this.** This is compliance testing and registration.

---

## R3. Shipping the power bank as ordinary parcel post
**Severity: Catastrophic (aviation) / Severe (commercial) · Likelihood: Near-certain if not addressed · Current exposure: Total**

**What it is.** IATA's current guidance is explicit and closes the loophole people usually rely on:

> "Other similar sources of power (power banks, power packs, etc, designed to primarily provide power to another device) are also classified as batteries and not batteries contained in equipment."
> — *IATA Battery Guidance Document*, revised for the 2026 Regulations: <https://www.iata.org/contentassets/05e6d8742b0047259bf3a700bc9d42b9/lithium-battery-guidance-document.pdf>

So the power bank is **UN3480** (lithium ion batteries, Packing Instruction 965) — **not** UN3481 (packed with / contained in equipment). UN3480 is Cargo Aircraft Only, state of charge ≤30% for air transport, Class 9 label plus the lithium battery mark, and a dangerous-goods declaration.

**Australia Post is the sharper problem.** Australia Post's own lithium battery quick-reference table permits Li-ion batteries ≤100 Wh "installed in equipment" by air and surface, but a battery "packed alongside equipment or by itself" is **✖ air and surface / ✔ domestic road only**, requiring the Australia Post "Road Transport Only" label and domestic mail only.
Sources: <https://auspost.com.au/sending/guidelines/dangerous-prohibited-items>, <https://auspost.com.au/content/dam/auspost_corp/media/documents/lithium-batteries-quick-reference-guide.pdf>

A power bank sits in the "by itself" row. It *is* the battery.

**Consequence.** Standard Parcel Post or Express Post interstate routes by air. Every such shipment is non-compliant with the carrier's own terms and with dangerous-goods rules. That voids carrier liability, likely voids insurance, and puts undeclared dangerous goods on an aircraft.

**Mitigation.**
- Choose a road-only domestic service with the Road Transport Only label, **or** a courier that explicitly offers ground lithium-battery freight. Confirm the policy in writing with the actual carrier — rules differ carrier to carrier and none of the private couriers were researched here.
- Ship at ≤30% state of charge.
- Package per the AusPost guide: original retail packaging where possible, equipment packed so it cannot switch on, terminals protected against short circuit, battery fully enclosed in inner packaging, strong outer packaging.
- No international orders for this SKU until a compliant international path exists. **This must be reflected in the hardware terms**, and it is — see the shipping section of `hardware-terms.html`.
- Confirm dangerous-goods training expectations with the carrier; a mandatory low-volume threshold could not be verified.

**Documents fix only the customer-facing half** (Australia-only, road freight, longer transit). The operational half is a fulfilment decision.

---

## R4. Trading structure — unlimited personal liability
**Severity: Catastrophic · Likelihood: Certain if sole trader · Current exposure: Total**

**What it is.** No ABN, ACN, "Pty Ltd" or registered business name appears anywhere in the repository — I searched. Every legal document currently says "an independent developer based in Australia," which is not a legal person you can identify.

If Clippar trades as a **sole trader**, there is no separation between business and personal assets. A Part 3-5 injury claim, an ACL penalty, or a defective-goods judgment reaches the house.

**Mitigation.** Decide the contracting entity before the first hardware sale, and put its legal name and ABN on the Terms, the Privacy Policy, the hardware terms, and the Stripe checkout. Discuss with an accountant and a lawyer whether a Pty Ltd is warranted — for a business selling a lithium battery to consumers, the usual answer is yes, and it should be done *before* supply, not after an incident.

**Documents cannot fix this.** It is a corporate-structure decision. The documents contain `[DECISION NEEDED: legal entity]` placeholders because writing a confident wrong answer would be worse.

---

# TIER 2 — SEVERE

## R5. Misleading conduct in Mount Kit marketing (ACL ss 18, 29)
**Severity: Severe · Likelihood: Moderate–High · Current exposure: Live now, on a public page**

`clippar-web/public/mount.html` is live and makes claims the code does not support:

| Claim on the page | What the code says |
|---|---|
| "AI shot detection — Pose, **ball flight** and impact audio" | `constants/config.ts` → `tracer.enabled: false`. The ball-flight tracer is disabled in production builds. |
| "finds and trims **every** swing automatically" | `config.detection.strategy: 'baseline'`; the app's own Terms concede detection is best-effort. "Every" is an absolute claim. |
| "A$99 · One-time · **no subscription**" | `config.subscription.enforceExportGate: true` — creating a highlight reel requires an active Clippar Pro subscription. The kit is one-time; the thing it exists to do is not. |
| "A$99" | `supabase/functions/create-payment-intent/pricing.ts` prices the same kit at **5900 / 6900 cents** (A$59 / A$69). Two channels, two prices, same product name. |
| "the combo is built to comfortably see out 18 holes" | No capacity figure, no test basis anywhere in the repo. |

**The law.** ACL s 18 (misleading or deceptive conduct) and s 29 (false or misleading representations about goods, including price and performance characteristics). Civil penalties under s 224 for a body corporate are the greatest of **A$100,000,000**, 3× the benefit obtained, or 30% of adjusted turnover; up to **A$2,500,000** for an individual. Source: <https://www.legislation.gov.au/C2004A00109/latest/text>.

**Mitigation.** These are not mine to edit — `mount.html` is outside my assigned scope. The register records them as required owner actions:
- Remove "ball flight" from the kit page until the tracer ships, or gate the claim.
- Replace "every swing" with an accurate best-effort formulation.
- Resolve the A$99 / A$59 / A$69 discrepancy to one price.
- Either remove "no subscription" or add a plain statement that reel export requires Clippar Pro.
- Substantiate the battery-life claim with a Wh figure, or soften it.
- Add the required commerce disclosures (see R6).

## R6. Mount Kit page carries none of the required sale disclosures
**Severity: Severe · Likelihood: Certain · Current exposure: Live now**

A grep of `mount.html` for warranty / refund / return / delivery language returns **zero matches**. The page takes A$99 and tells the buyer nothing about their rights.

**What is required.**
- **ACL** — you may not represent that guarantees are excluded, and s 29(1)(m) makes a false or misleading representation about the existence or effect of a guarantee an offence. Silence is not a breach, but a "no refunds" sign or an absent statement combined with a refusal is where businesses get caught.
- **Stripe's own activation checklist** requires, on the site that collects payment: a description of what you are selling, the currency, **customer service contact information**, **fulfilment policies (refund, shipping/delivery, return process, cancellation)**, legal or export restrictions, the privacy policy, **the business address**, promotion terms, and card logos.
  Source: <https://docs.stripe.com/get-started/checklist/website> (and <https://docs.stripe.com/account/checklist>).
- **Stripe Services Agreement (Australia)** s 13.3.1 expressly acknowledges non-excludable Australian Consumer Law guarantee rights: <https://stripe.com/en-au/legal/ssa>.

**Mitigation.** `clippar-web/public/hardware-terms.html` (created as part of this work) supplies all of it. **The owner must link to it from `mount.html`, at the checkout button and in the footer** — I do not own that file.

## R7. Warranty against defects — mandatory prescribed text
**Severity: Severe if a warranty is offered and worded wrong · Likelihood: High**

If Clippar offers any express warranty ("12-month warranty"), **Competition and Consumer Regulations 2010 reg 90** applies. The document must be transparent, state what the warrantor must do and what the consumer must do, prominently state the warrantor's **name, business address, telephone number and email**, state the period, the claim procedure and address, who bears the expense, that the benefits are **in addition to** other ACL rights — and it must contain the prescribed text **verbatim**. For goods only, reg 90(2):

> "Our goods come with guarantees that cannot be excluded under the Australian Consumer Law. You are entitled to a replacement or refund for a major failure and compensation for any other reasonably foreseeable loss or damage. You are also entitled to have the goods repaired or replaced if the goods fail to be of acceptable quality and the failure does not amount to a major failure."

Source: <https://www.legislation.gov.au/F1996B01420/latest/text> (reg 90; verified byte-identical across the 2022-09-17 and 2025-11-29 compilations).

Getting this wrong is a distinct contravention: **A$50,000** body corporate / **A$10,000** individual (ACL s 224(3) item 9).

**Mitigation.** `hardware-terms.html` includes the reg 90(2) text verbatim, with the warrantor-detail fields marked `[DECISION NEEDED]` — a name, a **postal business address**, and a **phone number** are all mandatory and none exist in the repo. If you would rather not offer an express warranty at all, delete that section entirely and rely on the statutory guarantees; reg 90 is then not triggered. That is a legitimate choice and arguably the simpler one.

## R8. Apple 3.1.1 — the lifetime redemption-code scheme
**Severity: Severe (app removal / rejection) · Likelihood: Moderate–High**

Guideline 3.1.1 states, verbatim:

> "If you want to unlock features or functionality within your app … you must use in-app purchase. **Apps may not use their own mechanisms to unlock content or functionality, such as license keys, augmented reality markers, QR codes, cryptocurrencies and cryptocurrency wallets, etc.**"
> — <https://developer.apple.com/app-store/review/guidelines/>

`supabase/migrations/018_redemption_codes.sql` + `supabase/functions/redeem-code/` implement exactly a bespoke license-key unlock: a peppered-hash code redeemed in-app that writes `user_entitlements` and sets `profiles.subscription_status = 'active'` with a NULL expiry — lifetime Pro, granted entirely outside StoreKit.

By contrast, the **hardware** sale is clearly fine: guideline **3.1.3(e)** requires that goods consumed outside the app use payment methods other than IAP. Selling the Mount Kit through Stripe on the web is the correct architecture, and `config.shop` already enforces it.

**Mitigation.** The compliant pattern is to make Lifetime Access a real **non-consumable IAP** and distribute it through **App Store Connect Offer Codes**, so the unlock happens inside Apple's rails. If the codes are only ever redeemed by people you hand them to privately and never advertised in-app, the risk is lower but not zero. Get a view on this before submission — a 3.1.1 rejection is recoverable; a pattern Apple reads as circumventing IAP is not always.

The Terms have been drafted so that codes are described accurately and as **revocable**, which matches `user_entitlements.revoked_at` in the schema.

## R9. Live Stripe link is in test mode
**Severity: Severe (commercially) · Likelihood: Certain**

`clippar-web/public/mount.html` line 959: `const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/test_fZu14h5Gj9VP3Y28aj1gs00';`

A live, indexed, public page with a **test-mode** checkout. A customer who reaches it either cannot pay or completes a transaction that takes no money. `config.shop.mountCommerceEnabled` is `false` in the app, so in-app surfaces are suppressed, but the web page itself is reachable and is linked from the sitemap.

**Mitigation.** Owner action, outside my scope: swap to the live link, or take the page down / noindex it until hardware is genuinely ready. Given R1–R4, **taking it down is the right call for now.**

---

# TIER 3 — MAJOR

## R10. Bystander filming — the risk the app creates for its own users
**Severity: Major (for the user); Moderate reputational/contributory for Clippar · Likelihood: Moderate**

Clippar puts a recording phone on a bag or buggy and asks users to film. On a course that means other golfers, in frame and within earshot. The current Terms bury this in one clause of an acceptable-use list. It deserves its own section, and now has one.

**Where the risk actually lies — audio, not video.** The research is clear that the exposure is asymmetric:

- **Queensland — Invasion of Privacy Act 1971, Part 4.** Audio only; the Act has **no** optical/video provisions at all. s 43(1): offence to use a listening device to overhear or record a "private conversation" — max 40 penalty units or 2 years (QLD penalty unit A$172.70 from 1 July 2026 → ~A$6,908). "Private conversation" excludes words spoken where a party ought reasonably expect to be overheard. **s 45 is the sting: publishing a private conversation is an offence even where you were a party and recorded it lawfully.** Sharing is a separate offence from recording.
  <https://www.legislation.qld.gov.au/view/whole/html/inforce/current/act-1971-050>
- **Queensland has no Surveillance Devices Act.** QLRC Report 77 (2020) recommended one; the consultation closed 31 May 2023 with no resulting Bill. As of August 2026 Queensland remains the only major Australian jurisdiction without a general video-surveillance statute. Monitor — this is an active reform area.
- **Criminal Code (Qld) s 227A** (observations/recordings in breach of privacy) almost certainly does not reach golf filming — "private act" is defined as showering, toileting, undress or intimate activity, and a golf course is not a "private place."
- **NSW — Surveillance Devices Act 2007.** s 7 (listening devices): max 100 penalty units / 5 years for an individual (A$11,000), 500 units for a corporation. **s 8 (optical) is trespass-based, not privacy-based** — it requires unauthorised entry onto premises or interference with a vehicle. A golfer with a green fee has consent to be there, so s 8 does not bite. s 11 (publication) therefore has little independent effect beyond the audio route.
  <https://legislation.nsw.gov.au/view/whole/html/inforce/current/act-2007-064>
- **Victoria — Surveillance Devices Act 1999.** s 7 (optical) is broader than NSW — no trespass requirement — **but** the s 3 definition of "private activity" expressly "does not include an activity carried on outside a building." Outdoor golf is categorically incapable of being a private activity. The exception: filming **inside a clubhouse**. Max level 7 (2 years / 240 penalty units individual at A$209.10/unit → ~A$50,184; 1200 units corporate → ~A$250,920).
  <https://content.legislation.vic.gov.au/sites/default/files/2025-12/99-21aa048-authorised.pdf>
- **Statutory tort for serious invasions of privacy — commenced 10 June 2025**, Schedule 2 to the Privacy Act 1988, inserted by the Privacy and Other Legislation Amendment Act 2024. Elements: intrusion upon seclusion and/or misuse of information; reasonable expectation of privacy; **intentional or reckless**; **serious**; privacy interest outweighing countervailing public interest. **Actionable without proof of damage.** Damages for non-economic loss capped at the greater of A$478,550 or the defamation cap. **There is no personal or domestic purpose exemption** — unlike the main Privacy Act's s 7B(1) carve-out. An ordinary user filming for fun is not automatically shielded.
  <https://www.oaic.gov.au/privacy/your-privacy-rights/more-privacy-rights/statutory-tort-for-serious-invasions-of-privacy>
- Background law: *Victoria Park Racing v Taylor* (1937) 58 CLR 479 — no general right in Australia to prevent being observed. *ABC v Lenah Game Meats* (2001) 208 CLR 199 — left a privacy tort open; ancestor of the 2024 statutory tort.

**Mitigation.** The rewritten Terms now carry a dedicated "Filming other people" section that: names audio as the sharp edge; explains that sharing can be a separate and more serious offence than recording; tells users to ask before pointing a camera at someone and to respect club rules; and states plainly that the user, not Clippar, is responsible. There is also a practical product mitigation worth considering: **an option to record without audio**, or to strip the audio track on export. `hooks/useCamera.ts` already handles microphone denial gracefully (the detector falls back to pose-only), so the capability is most of the way there. That would materially reduce the highest-probability legal harm the app creates.

## R11. Privacy Policy misdescribes how footage is handled
**Severity: Major · Likelihood: Certain (it is wrong today) · Current exposure: Live**

Verified against the code:

| Current policy says | Repository shows |
|---|---|
| "Your footage is uploaded to our storage **and to our video-processing service** so it can be analysed, trimmed, and stitched" — and a "Our video-processing service" row in the providers table receiving "round ID and clips, and optionally your name/email" | **There is no video-processing service.** Detection, trimming and reel assembly are entirely on-device: `modules/shot-detector/ios/ShotDetectorModule.swift` and `composeReel()` using `AVMutableComposition` (`modules/shot-detector/index.ts:481`). `lib/pipeline.ts` (`submitJob`, `getJobStatus`) has **zero call sites**. `config.concat.url` is read by nothing. |
| Footage is uploaded (unconditional) | **Cloud backup is opt-in, Pro-only, and off by default.** `lib/storage.ts:558 getCloudBackupEnabled()` returns true only when the setting is `'1'`; `app/profile/storage-settings.tsx` gates the toggle behind an active subscription. |
| "Push token — a device push-notification token, if generated" | Not collected. `app.config.js` deliberately omits the `expo-notifications` plugin; `registerForPushNotifications()` has no call sites. |
| "Merchandise order and shipping records are **retained** as part of our order history" (§9) | `supabase/functions/delete-account/index.ts` **deletes** `hardware_orders` for the user. The statement is false, and separately the deletion conflicts with ATO record-keeping. |
| Supabase "hosted in Australia — Sydney region" | No evidence in the repository either way. Must be verified in the Supabase dashboard. |

**Why this matters legally.** Even where the Privacy Act's small-business exemption applies (R12), a false statement in a privacy policy about how you handle a customer's video is a **representation about your service** and is squarely within ACL s 18 / s 29 — the ACCC, not just the OAIC, is the relevant regulator. Overclaiming that a third party touches customers' golf footage is the kind of statement that reads badly in every direction.

**Mitigation.** `privacy.html` has been rewritten to match the code exactly, including the on-device processing story, the opt-in backup default, and the removal of the phantom processor and the push token.

## R12. Undisclosed collection of IP addresses
**Severity: Major · Likelihood: Certain · Current exposure: Live**

IP addresses are collected in three places and appear nowhere in the current policy:

1. `supabase/functions/_shared/rateLimit.ts` → `RATE_LIMITS.getSharedReel` uses bucket `get-shared-reel-ip`, keyed by **client IP**, 120/hour, stored as `api_rate_limit.subject` (migration `016_api_rate_limit.sql`). These are the IPs of **people who open a shared reel link and are not Clippar users at all**.
2. The same table stores IPs for anonymous callers of `search-courses`.
3. `clippar-web/api/submit.py` → `_client_ip()` writes `"ip:" + address` into `waitlist_rate_limit.subject` on Neon, 5/hour per IP.

An IP address is capable of being personal information under the Privacy Act where it is reasonably identifiable. Collecting it silently is the mirror image of R11 — underclaiming rather than overclaiming, but the same defect.

**Mitigation.** Disclosed in the rewritten `privacy.html`, with the purpose (abuse prevention) and the fact that it applies to reel viewers as well as users. Consider a retention/purge job on `api_rate_limit` and `waitlist_rate_limit` — APP 11.2 expects destruction or de-identification once no longer needed, and these rows have no value past their window.

## R13. Privacy Act coverage — the small-business exemption is a trap you should decline
**Severity: Major · Likelihood: Moderate**

**Position.** Privacy Act s 6D exempts a business with annual turnover ≤ **A$3,000,000**. Clippar is presumably under that. But:

- The exemption is **ratcheted**: exceed A$3M once and you are permanently covered, even if turnover later falls (s 6D(4)(a)).
- Two exceptions are live on these facts: s 6D(4)(c), disclosing personal information about another individual **for a benefit, service or advantage**, and s 6D(4)(d), providing a benefit to collect it. OAIC's guidance anchors these to genuine trading in data (<https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/trading-in-personal-information>), and there are two workable defences — routine SaaS subprocessing is characterised as "use" not "disclosure" where effective control is retained by contract (APP Guidelines Ch B, B.147), and s 6D(7)(a) disapplies (c) where disclosure is with consent. Neither is bulletproof and there is no case law on point.
- The exemption **does not touch the statutory tort** (R10) — Schedule 2 is read and construed separately.
- Removal of the small-business exemption is a stated Government commitment ("Tranche 2") but **no Bill is before Parliament as of August 2026**. Not imminent; do monitor.
- Apple requires an accurate privacy policy regardless (guideline 5.1.1(i)), and ACL s 18 applies to whatever you publish regardless.

**Recommendation.** Write and operate to the APPs whether or not you are technically bound. It costs nothing you are not already doing, removes the argument entirely, and is what the rewritten policy does. Consider **opting in under s 6EA** — a free written election to the Commissioner, revocable, which places the trading name and ABN on a public register (<https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/opting-in-to-the-privacy-act>). That is a commercial/trust decision, not a compliance necessity. **`[DECISION NEEDED: opt in under s 6EA, yes or no]`**

## R14. Cross-border disclosure (APP 8) and the accountability rule
**Severity: Major · Likelihood: Moderate**

Confirmed overseas recipients, from the code:
- **Sentry** — DSN `o4511382424518656.ingest.us.sentry.io` (`app/_layout.tsx:50`), **United States**, initialised unconditionally at app start with `tracesSampleRate: 0.1`.
- **RevenueCat** — United States (`lib/iap.ts`, `delete-account` calls `api.revenuecat.com`).
- **Stripe**, **Apple**, **Google**, **Expo/EAS OTA updates** (`u.expo.dev`, in `app.config.js` — an undisclosed recipient in the current policy), **Neon** and **Sender.net** for the website waitlist.

**The rule.** APP 8.1 requires reasonable steps to ensure an overseas recipient does not breach the APPs. **s 16C** then deems any breach *by that recipient* to have been committed *by you*. Taking reasonable steps does not extinguish s 16C. There is **no Australian equivalent of EU Standard Contractual Clauses** — a reviewed vendor DPA is the compliance path.
Sources: <https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information>, <https://www.legislation.gov.au/C2004A03712/latest/text>

**Note on the current policy's wording.** It says "we rely on these third parties to protect your data consistent with this policy." That is precisely the posture APP 8 and s 16C reject. The rewritten policy names each recipient, its country, and what it receives, and does not claim the obligation has been outsourced.

**Mitigation.** Execute and file DPAs with Sentry, Supabase, RevenueCat, Stripe, Neon and Sender.net. Mitigating fact worth noting: **`Sentry.setUser()` is never called anywhere in the app** — account ID and email are not attached to crash reports, and `sendDefaultPii` is not enabled. That is a genuinely good privacy posture and the policy now says so accurately.

## R15. Notifiable Data Breaches
**Severity: Major · Likelihood: Low**

If the exemption does not apply (or you opt in), Part IIIC applies: an eligible data breach is unauthorised access/disclosure or loss where a reasonable person would conclude **serious harm** is likely (s 26WE(2)); a suspected breach must be assessed reasonably and expeditiously, with all reasonable steps taken to complete it **within 30 days** (s 26WH); a statement then goes to the OAIC and to affected individuals as soon as practicable (ss 26WK–26WL). Remedial action that removes the likelihood of serious harm means it was never an eligible breach (s 26WF).
<https://www.oaic.gov.au/privacy/notifiable-data-breaches/about-the-notifiable-data-breaches-scheme>

Clippar holds video of identifiable people plus location. That is a high-harm dataset.

**Mitigation.** A written, one-page breach response plan with the 30-day clock and the notification template on it. The rewritten policy commits to notifying, without over-promising a timeframe.

## R16. Subscription and trial disclosure (Apple 3.1.2)
**Severity: Major (rejection) · Likelihood: Low–Moderate**

Apple 3.1.2(c) requires clear pre-purchase description and compliance with Schedule 2 of the Developer Program License Agreement. Apple's own Media Services Terms set the language users are told to expect:

> "You will be charged no more than twenty-four (24) hours prior to the start of the latest Subscription period."
> "Subscriptions automatically renew until cancelled in the Manage Subscriptions section of your account settings."
> "If you decide to unsubscribe from a Subscription before we start charging your payment method, cancel the Subscription at least twenty-four (24) hours before the free trial ends."
> — <https://www.apple.com/legal/internet-services/itunes/us/terms.html>

Refunds for IAP are processed by Apple, not the developer; StoreKit gives the developer no refund-issuance API (the developer only receives refund notifications: <https://developer.apple.com/documentation/storekit/handling-refund-notifications>).

3.1.2(a) also requires the subscription to "provide ongoing value." Note that `enforceExportGate: true` makes reel export the paid feature — that is real, ongoing value, and it is defensible. But the paywall copy must describe what is actually delivered; the config comments already flag that advertising four Pro benefits while Pro granted nothing would be a 3.1.2 misrepresentation.

**Mitigation.** The rewritten Terms state price, period, trial length, auto-renewal, the 24-hour cancellation window, where to cancel, that deleting the Clippar account does not cancel the Apple subscription, and that Apple handles refunds. Verify the in-app paywall copy matches before submission. **`[DECISION NEEDED: confirm the trial is 14 days in App Store Connect for both products]`** — `config` comments say "2-week free trial," and `lib/iap.ts` reads `trialDays` from StoreKit eligibility rather than hardcoding it, so the store is the source of truth.

## R17. Apple 5.1.1 / 4.8 / privacy manifest
**Severity: Major (rejection) · Likelihood: Low — mostly already correct**

Good news first, all verified:
- **5.1.1(v) account deletion** — implemented properly. `supabase/functions/delete-account/index.ts` is real deletion, self-scoped, requires a token minted within 10 minutes, and revokes the Sign in with Apple refresh token. Meets <https://developer.apple.com/support/offering-account-deletion-in-your-app/>.
- **4.8 Login Services** — note this guideline is now titled "Login Services" and no longer names Sign in with Apple. It triggers because Clippar offers Google Sign-In (`components/auth/SocialAuthButtons.tsx`, used on both `login.tsx` and `signup.tsx`); Sign in with Apple is offered alongside, which satisfies it.
- **Privacy manifest** — `app.config.js` declares `NSPrivacyCollectedDataTypes` and required-reason APIs (CA92.1, C617.1, E174.1, 35F9.1), `NSPrivacyTracking: false`, no tracking domains. This is in better shape than most apps.
- **5.1.5 Location** — When-In-Use only; `locationAlwaysPermission: false`. Correct.

Residual items:
- The manifest declares `PreciseLocation` and `PhotosorVideos` as collected. Given cloud backup is off by default, that is the conservative and correct call — keep it.
- Third-party SDK requirements (<https://developer.apple.com/support/third-party-SDK-requirements/>) apply to SDKs on Apple's list; audit Sentry, Stripe, RevenueCat and Supabase against it before each submission.
- The App Store privacy answers must match the rewritten policy. They currently reference a video-processing service that does not exist.

## R18. Music licensing
**Severity: Major · Likelihood: Low–Moderate**

Nine of the twelve bundled tracks are documented properly in `docs/music-licenses/README.md` — Pixabay Content License, per-track source URLs, download date 2026-07-23, archive snapshots, and a genuinely good judgement call rejecting one track whose artist's profile disclaimed commercial use. That is better diligence than most.

Two gaps:
1. **Three legacy tracks — `chill_vibes.m4a`, `focus_mode.m4a`, `victory_lap.m4a` — have no licence provenance at all.** The doc says only that they "predate this library (originally bundled as Clippar in-house/royalty-free assets)." "Royalty-free" is not a licence and "in-house" is not evidence. These ship in the binary and end up in user reels posted to social platforms.
2. Three of the nine Pixabay archive snapshots failed (HTTP 520) and were never retried, so the provenance record is incomplete for those.

**Mitigation.** Either establish and file the provenance for the three legacy tracks, or remove them from `MUSIC_LIBRARY` for new reels (the ID map must stay so existing reels keep resolving — `lib/musicLibrary.ts` already documents this constraint). Retry the three failed archive saves. Note that Content ID claims on user-posted reels are a user-experience problem before they are a legal one, and the Pixabay licence does not protect a user against a platform's automated claim.

---

# TIER 4 — MODERATE

## R19. Share links are documented but do not work
**Severity: Moderate · Likelihood: Certain**

`create-share-link` mints a 128-bit token and writes `rounds.share_token`. `get-shared-reel` requires `share_token IS NOT NULL AND is_published = true` (index.ts:126). **Nothing in the repository ever sets `is_published = true`** — migration `019_tenant_isolation.sql` says so in terms. Every web share link returns "not available."

Both the current and rewritten Terms describe share links. Describing a feature that does not function is a consumer-guarantee issue (ACL s 54/s 55) and, if it is used to sell Pro, a s 18 issue.

There is also **no way to un-share**. The current Terms say a reel is viewable "until you remove it" — there is no removal path in the code.

**Mitigation.** The rewritten Terms describe sharing accurately: the working path (the iOS share sheet, which shares the video file directly) is described as the main one, and web links are described with the honest caveat. Fix the feature or remove the claim. If you fix it, read the warning in `019_tenant_isolation.sql` first — the obvious-looking fix re-opens a policy branch that would expose every user's raw per-hole clips to any signed-in stranger.

## R20. Deleting hardware order records conflicts with tax law
**Severity: Moderate · Likelihood: Certain once orders exist**

`delete-account` deletes `hardware_orders` rows. The ATO generally requires business records supporting a transaction to be kept for **five years**. A customer exercising account deletion should not be able to erase your sales records.

Mitigating fact: `stripe-webhook`'s row builder writes no shipping address, and the web Payment Link path keeps the customer's name, email and address in **Stripe**, not Supabase. So the accounting source of truth survives. Still, the code and the policy should agree, and the policy now says the truthful thing: order records are retained by Stripe as required for tax and accounting.

**Mitigation.** Consider anonymising rather than deleting `hardware_orders` (null the user_id, keep the amount and date). Confirm with an accountant.

## R21. Spam Act and marketing to the waitlist
**Severity: Moderate · Likelihood: Moderate**

`clippar-web/api/submit.py` collects name, email and frequency preference and pushes them to Sender.net. Any commercial electronic message needs: **consent** (express, or inferred from an existing business relationship), **accurate sender identification with contact details valid ≥30 days**, and a **functional unsubscribe** honoured within 5 working days, free and without login (Spam Act 2003 ss 16–18, Sch 2). Penalties scale in penalty units (Commonwealth unit A$364 from 1 July 2026): a body corporate with no prior record faces up to A$36,400 per s 16 contravention, up to A$728,000 for multiple same-day contraventions.
<https://www.acma.gov.au/avoid-sending-spam>

Waitlist signups are express consent, which is the strong position. Keep the signup record as evidence, and ensure the Sender.net template carries the sender identification and unsubscribe link.

## R22. Children
**Severity: Moderate · Likelihood: Low**

Terms set a minimum age of 13. The **Children's Online Privacy Code** is not yet in force — the exposure draft consultation ran 31 March to 5 June 2026 and the Code must be registered by **10 December 2026** (<https://www.oaic.gov.au/privacy/privacy-registers/privacy-codes/childrens-online-privacy-code>). It is expected to cover designated internet services likely to be accessed by children. Monitor; the App Store age rating and the 13+ floor should be reviewed against it when it lands.

Also note: from **10 December 2026**, APP 1.4 privacy policies must disclose the use of automated decision-making that could significantly affect individuals' rights or interests. Clippar's swing detection is automated but does not make decisions about people's rights, so this likely does not bite — worth a second look closer to the date.

## R23. Governing law and jurisdiction clause
**Severity: Moderate · Likelihood: Low**

The current Terms say "the laws of Australia" and "the courts of Australia." Neither is a jurisdiction. Australia has nine. The rewritten Terms specify **Queensland** and the courts of Queensland, non-exclusive, with the mandatory-consumer-law saving clause preserved.

## R24. Liability cap of A$50
**Severity: Moderate · Likelihood: Moderate**

The current Terms cap total liability at the greater of 12 months' fees or **A$50**. For a subscription service that is arguably within ACL s 64A's permitted limitation, but s 64A only applies to goods and services **not** ordinarily acquired for personal, domestic or household use — and a golf app plainly is such a service. So the cap is likely void as against consumer guarantees, and a cap that is void is close to a representation that guarantees are limited, which brings s 29(1)(m) into view.

**Mitigation.** The rewritten Terms keep a limitation for non-guarantee claims but lead with an unambiguous statement that nothing limits the consumer guarantees, and drop the A$50 figure, which reads as a term drafted to be unfair and would be construed against the drafter.

---

# TIER 5 — LOW

- **R25.** `lib/pipeline.ts` and `lib/pipeline.web.ts` are dead code holding an API key reference (`config.pipeline.apiKey`). `lib/r2.ts:419` still has a live fallback branch calling `config.pipeline.url`. Delete the dead module and the fallback so the privacy documentation cannot drift back out of true.
- **R26.** `lib/r2.ts` is named for Cloudflare R2 but writes to Supabase Storage. A naming trap for whoever next writes a privacy policy from the code.
- **R27.** The website loads Google Fonts from `fonts.googleapis.com` / `fonts.gstatic.com`, which receives visitors' IP addresses. Disclosed in the rewritten policy. Self-hosting the two fonts removes the issue entirely and is a ten-minute change.
- **R28.** `mount.html` and `index.html` are not linked to the new hardware terms page. Owner action.
- **R29.** No cookie banner exists, and none is needed — `r.html` and `index.html` set no cookies and load no analytics or ad trackers. Verified. Keep it that way; it is a real asset.

---

# `[DECISION NEEDED]` — the complete list

These appear as marked placeholders in the documents. Every one is something I could not determine from the code or the research, and a confident wrong answer would be worse than a visible gap.

| # | Decision | Appears in | Blocking? |
|---|---|---|---|
| 1 | **Legal entity + ABN/ACN** — sole trader or Pty Ltd, and its registered name | terms, privacy, hardware-terms | **Yes — hardware** |
| 2 | **Registered business address** (postal, not an email) | hardware-terms (reg 90 requires it) | **Yes — hardware** |
| 3 | **Contact telephone number** | hardware-terms (reg 90 requires it) | **Yes — hardware** |
| 4 | **Power bank capacity (Wh/mAh), chemistry, cell manufacturer, country of origin** | hardware-terms | **Yes — hardware** |
| 5 | **UN 38.3 test summary and IEC/AS 62133 certification held on file?** | not published, but must exist | **Yes — hardware** |
| 6 | **Does the kit include a mains wall charger?** If so, EESS Level 3 registration + RCM | hardware-terms | **Yes — hardware** |
| 7 | **ACMA RCM / Responsible Supplier registration for the Bluetooth clicker** | — | **Yes — hardware** |
| 8 | **Shipping carrier and service** (must be road-only, DG-capable, domestic) | hardware-terms | **Yes — hardware** |
| 9 | **Delivery timeframe** to quote | hardware-terms | **Yes — hardware** |
| 10 | **Warranty period**, or the decision to offer no express warranty | hardware-terms | **Yes — hardware** |
| 11 | **Change-of-mind returns window**, if any (not required by law) | hardware-terms | No |
| 12 | **Final price** — A$99 (web) vs A$59/A$69 (`pricing.ts`) | hardware-terms, mount.html | **Yes — hardware** |
| 13 | **Product liability insurance** — obtained, insurer, limit | — | **Yes — hardware** |
| 14 | **Supabase project region** — the policy currently asserts Sydney with no repo evidence | privacy | No |
| 15 | **Opt in to the Privacy Act under s 6EA?** | privacy | No |
| 16 | **Trial length in App Store Connect** — confirm 14 days on both products | terms | No |
| 17 | **Lifetime codes** — keep the bespoke scheme, or move to Apple Offer Codes | terms | Review before submission |
| 18 | **Provenance for the three legacy music tracks** | — | No |

---

# What the documents cannot fix

Listed separately because it is the part people skip.

| Risk | What is actually needed |
|---|---|
| R1 — battery fire | **Product liability insurance.** Supplier compliance certificates. A supplier indemnity. In-box warnings. |
| R2 — electrical safety | **EESS scope determination, certification, and registration.** A written answer from a regulator. |
| R3 — dangerous goods shipping | **A different carrier or service.** An operational change to fulfilment and to state of charge at packing. |
| R4 — personal liability | **A corporate structure decision**, made with an accountant and a lawyer, before supply. |
| R5/R6 — mount page claims | **Edits to `mount.html`**, which is outside my assigned scope. |
| R8 — Apple 3.1.1 codes | **A product decision** — move to Offer Codes, or accept review risk. |
| R14 — APP 8 | **Executed DPAs** with each overseas processor. |
| R18 — legacy music | **Evidence** of licence, or removal of the tracks. |

---

# Shortlist — what the owner must decide or obtain before selling hardware

In priority order. Items 1–4 are gating: do not take money for a Mount Kit until they are done.

1. **Product liability insurance covering a lithium-ion battery product, in force.** Get quotes from brokers who are told about the battery. This is the single highest-value thing on this list.
2. **The contracting entity.** Sole trader or Pty Ltd, with an ABN. A sole trader selling lithium batteries has their personal assets behind every Part 3-5 claim. Decide this before supply, not after.
3. **A compliant shipping path.** A road-only domestic dangerous-goods service, confirmed in writing with the carrier, at ≤30% state of charge, with correct labelling and packaging. Australia Post will not carry this by air or general surface. No international orders until a compliant route exists.
4. **Electrical and radio compliance.** A written EESS scope determination for the power bank; if a mains charger is included, Level 3 certification, RCM marking and Responsible Supplier registration before supply. ACMA RCM and supplier registration for the Bluetooth clicker.
5. **Supplier compliance pack on file** — UN 38.3 test summary, IEC/AS 62133 certification, factory identity and address, batch traceability, and a written defect indemnity.
6. **A lawyer's review of the hardware terms and the warranty document.** Specifically the reg 90 mandatory text and the warrantor details, which must be exact.
7. **Fix the Mount Kit page.** Take it down or point it at a live Stripe link — a test-mode checkout is live and indexed today. Remove the "ball flight" claim while the tracer is disabled, resolve the A$99/A$59/A$69 price conflict, soften "every swing," and reconcile "no subscription" with the Pro export gate. Link the new hardware terms from the page and the footer.
8. **An incident procedure that can meet the 2-day s 131 reporting deadline**, and a recall plan that can meet s 128.
9. **Decide the warranty question** — offer an express warranty with exact reg 90 wording, or offer none and rely on the statutory guarantees. The second is simpler and perfectly legitimate.
10. **Settle the remaining `[DECISION NEEDED]` fields** in `hardware-terms.html` — entity, address, phone, capacity, delivery window, price — and remove the placeholders before the page goes live.
