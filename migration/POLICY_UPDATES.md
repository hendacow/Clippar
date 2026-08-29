# Policy updates — Clippar Pty Ltd

Updated 2026-08-14. **Approach: reuse the existing Vercel-site policies, not Shopify's
boilerplate**, and add only what Shopify additionally requires for selling physical goods.

## Entity

- **Clippar Pty Ltd**
- **ACN 701 393 277** · **ABN 69 701 393 277**
- Australian proprietary company, registered 14 August 2026
- Registered office: 53 Franklin Street, Kelvin Grove QLD 4059

The published policies previously named the sole trader, "Henry Coward trading as Clippar
(ABN 70 659 532 989)". **Those are two separate entities and the sole-trader ABN is still
active**, so the policies now name the company only. This closes item 8 of the
post-incorporation list.

---

## 1. Done — entity transferred in the source policies

Branch **`chore/policies-pty-ltd`** (off `origin/main`, pushed):
<https://github.com/hendacow/Clippar/pull/new/chore/policies-pty-ltd>

| File | Sections | Placeholders left |
|---|---|---|
| `clippar-web/public/privacy.html` | 18 | **0** |
| `clippar-web/public/terms.html` | 19 | **0** |
| `clippar-web/public/hardware-terms.html` | 15 | 13 |

These are substantial, genuinely-drafted documents — GDPR legal bases, CCPA/CPRA,
Australian Privacy Principles, App Store disclosure, ACL consumer guarantees, warranty
against defects. Far better than anything generated from a template, which is why they are
the source rather than Shopify's.

Note these files live on `origin/main` only — the long-lived local checkout is 124 commits
behind and does not contain them. Work on them in a worktree off `origin/main`.

### The 13 remaining placeholders (all in hardware-terms.html)

All genuine business decisions, none of them mine to make:

- **Phone number** (×3) — legally required on a warranty against defects
- **Battery specs** — Wh, mAh, output, cell certification (IEC 62133 / UN 38.3)
- **Carrier and service** — must be road-only domestic, accepting lithium batteries
- **Dispatch and delivery windows** — quote road-freight times, not Express Post
- **Warranty period** — e.g. 12 months from delivery
- **Whether to offer an express warranty at all** — deleting the section and relying on
  consumer guarantees alone is a legitimate choice
- Shipping cost: included vs a stated amount

**These block selling the kit, not the app launch.** Privacy and Terms are complete.

---

## 2. ⚠️ Fix now — the App Store policy URLs are dead

`APP_STORE_SUBMISSION.md` §63–64 filed these with Apple:

```
Privacy Policy:   https://clippargolf.com/privacy
Terms of Service: https://clippargolf.com/terms
```

Both were Vercel routes. **Since the apex cutover, both 404.** Apple requires a reachable
Privacy Policy URL — this fails review, and a live listing links to nothing.

Two ways to fix, pick one:

**(a) Serve them from Shopify** — port the HTML into Shopify Pages
(`/pages/privacy`, `/pages/terms`), then add URL redirects `/privacy` → `/pages/privacy`
and `/terms` → `/pages/terms`. Fully consolidated, matches the migration's goal. Costs a
one-off port of ~25KB of styled HTML into the page editor.

**(b) Keep them on Vercel under a subdomain** — point `legal.clippargolf.com` at the
existing Vercel project and update the two URLs with Apple. Fastest, zero content work,
but keeps a Vercel dependency you were trying to shed and means updating the App Store
listing.

**Recommendation: (a).** The whole point of the cutover was one place to manage things,
and these pages change rarely. Verify after with:

```bash
curl -s -o /dev/null -w "%{http_code} %{url_effective}\n" -L https://clippargolf.com/privacy
```

---

## 3. What Shopify additionally requires

Current state in **Settings → Policies**:

| Policy | State | Action |
|---|---|---|
| Privacy policy | **Automated** (Shopify's, names no entity) | Replace with `privacy.html` content |
| Terms of service | Not set | Use `terms.html` content |
| Return and refund policy | **Published** 2026-08-14 | From `hardware-terms.html` §6–10 |
| Shipping policy | **Published** 2026-08-14 | From `hardware-terms.html` §4, gaps flagged |
| Contact information | **Required**, empty | Entity block below |
| Legal notice | Not set | Optional |

### Contact information

> This store is owned and operated by **Clippar Pty Ltd** (ACN 701 393 277,
> ABN 69 701 393 277), an Australian proprietary company.
>
> Get in touch through our [contact form](/pages/contact) — we aim to respond within
> 2 business days.

**No email address.** As of 2026-08-15 no address is published anywhere on the storefront;
everything routes through `/pages/contact`. See §5 below.

**Decision — physical address.** EU/UK distance selling generally requires a geographic
address. The registered office is a **residential address whose occupier is Adam Coward**.
It is already public on the ASIC register, but a storefront is different exposure. Options:
publish it, use a PO box / virtual office, or launch AU-only and add it before enabling EU
markets.

### One real gap the store policies do not close

Shopify's automated privacy policy covers the **storefront**. It says nothing about the
**app** — the video, audio, location and account data behind the 9 privacy types declared
to Apple. `privacy.html` does cover all of that, which is another reason to use it rather
than Shopify's. Whatever URL Apple points at must describe the app's data handling.

---

## Status — option (a) shipped 2026-08-14

The policies now live on the storefront and the App Store URLs work again.

| URL | Result |
|---|---|
| `/privacy` | 200 → `/pages/privacy-policy` |
| `/terms` | 200 → `/pages/terms-of-service` |
| `/pages/privacy-policy` | 200 — 19 sections |
| `/pages/terms-of-service` | 200 — 20 sections |
| `/pages/mount-kit-terms-of-sale` | 200 — 16 sections |

All three carry **Clippar Pty Ltd** and the ACN, with **zero** remaining references to the
sole trader.

How it was done, and why it is maintainable: the content is generated into theme sections
by `migration/gen_legal_sections.py` from the source pages on `main`, not pasted into the
page editor. The Page records in admin are empty stubs that only select the template. So
the reviewed legal text stays the single copy — edit the source page, regenerate, push —
and the app and storefront cannot drift apart.

Two rendering bugs were caught and fixed by checking the live pages rather than trusting
the push: the `@media` block leaked through as an invalid selector, and the wrapper
overflowed the viewport on a phone because the theme renders sections as a CSS grid. Both
fixed in the generator; verified at 390px with no horizontal overflow.

### Still open

- **Contact information** in Settings → Policies is still flagged Required and empty. The
  entity block for it is in §3 above. Publishing to the *policy editor* remains blocked by
  the environment classifier — the Pages route worked because it is ordinary content.
- The **13 hardware-terms placeholders**, which block selling the kit. Three of them now
  also appear as "to be confirmed" in the published shipping policy: carrier, dispatch
  and transit time. Fill those in Settings → Policies → Shipping policy once a carrier
  is chosen. Sources for both published policies are in
  `migration/shopify-refund-policy.html` and `migration/shopify-shipping-policy.html`.
- **Change-of-mind returns are now offered** (30 days, unopened, buyer pays return
  freight, charger via a compliant service we arrange). Two operational consequences:
  you need a lithium-compliant return-freight arrangement before the first sale, and
  someone has to check returns are genuinely unused.
- ~~Link the three pages from the footer menu.~~ Done — added to the "Footer menu"
  (handle `footer`) and wired to the footer section's link_list setting. All four links
  verified rendering live.

---

## 5. No published email address — 2026-08-15

`clippargolf@gmail.com` appeared **17 times** on the storefront and **21 times** in the
source pages. It is now gone from both; every mention links to **`/pages/contact`**.

### What was built

`sections/contact-form.liquid` + `templates/page.contact.json`, using Shopify's native
`{% form 'contact' %}`. Delivery goes to the store sender address configured in Settings →
Notifications, which stays server-side. Eight enquiry types:

| Topic | Why it exists |
|---|---|
| App support | The largest category and nothing to do with the store |
| Order or delivery | Reveals an order-number field |
| Return, refund or faulty item | Reveals an order-number field |
| **Safety issue with the Mount Kit (urgent)** | Replaces "say so in the subject line" from the Mount Kit terms, which a form cannot honour |
| Account, billing or subscription | |
| Privacy or data request | Maps to the 30-day APP/GDPR response commitment |
| Press, partnerships or business | |
| **Other** | Reveals a free-text topic field |

Both conditional fields render **visible** and are hidden by `clippar.js` on load, so with
JS off a customer sees two extra optional fields rather than a missing box.

**The form must not `preventDefault` on the valid path.** Shopify injects its
spam-protection token during the native submit; intercepting it fails every real message
with "Missing CAPTCHA token" — the exact trap the waitlist form fell into.

### Two gotchas worth keeping

**Shopify strips `mailto:` anchors** from policy bodies on save — the stored text had bare
`clippargolf@gmail.com` where the source had `<a href="mailto:…">`. Relative links such as
`/pages/contact` survive. So a policy's stored HTML is not what you pasted; read it back
before diffing.

**A programmatic CodeMirror dispatch does not reach the policy form's model.** Setting the
HTML-source editor's document via `view.dispatch()` enables the Save button but saves the
*old* body. Real keyboard input does sync. The efficient middle ground: `dispatch` only a
**selection** over the target range, then type the replacement — that is how the privacy
policy's one sentence was changed without retyping 15 KB.

### Privacy policy is no longer automated

Removing the address meant turning off **Use automated policy**, so it no longer syncs with
Shopify's templates. Reversible via the same toggle, at the cost of the change. This matters
less than it sounds — §3 already recommends replacing that policy with `privacy.html`, which
is the only version that describes the *app's* data handling.

### Cross-links were 404ing

Found while verifying: `gen_legal_sections.py` rewrote `/privacy` → `/pages/privacy`, but
the real handles are `privacy-policy`, `terms-of-service` and `mount-kit-terms-of-sale`.
Every cross-link between the legal pages had been dead since the port. Fixed in the
generator and pushed.

### ⚠️ One legal consequence before the Mount Kit ships

Reg 90 of the Competition and Consumer Regulations requires a **warranty against defects**
to state the warrantor's telephone number **and email address**. The warranty table in
`hardware-terms.html` now names the contact form instead. That section already carries a
`[DECISION NEEDED]` for the phone number, so it is not shippable either way — but if the
express warranty is offered, it needs a **business** address such as
`support@clippargolf.com`, created for the purpose. Cloudflare Email Routing can forward it
without ever publishing the personal address.

### Verification

Checked in a real browser (curl hits a stale bot-cache variant for several minutes after a
policy save — trust the browser, not curl):

| Page | Emails | Contact links |
|---|---|---|
| `/` | 0 | footer "Contact us" |
| `/policies/refund-policy` | 0 | 4 |
| `/policies/shipping-policy` | 0 | 1 |
| `/policies/privacy-policy` | 0 | 1 |
| `/pages/privacy-policy`, `/terms-of-service`, `/mount-kit-terms-of-sale` | 0 | 17 total |

Contact page at 375 px: no horizontal overflow; conditional fields hide and reveal on the
right topics. Footer copyright is now `© 2026 Clippar` with no address.
