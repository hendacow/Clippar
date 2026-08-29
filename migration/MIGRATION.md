# clippargolf.com → Shopify apex cutover

**Store:** `0zegsv-ef.myshopify.com`
**Current:** apex + www on Vercel (`clippar-web/`), DNS at Cloudflare, Shopify theme in `clippar-shop/`
**Target:** apex + www on Shopify, waitlist captured as Shopify customers, email sent
natively from Shopify. **Sender is retired** — see §2.1.

This is option (B) from `SHOPIFY_PORT_PLAN.md` §6.2. That plan recommended (A), the
`shop.` subdomain. The reasons to override it — one payment stack, one place to manage
international selling — are product decisions, and the SEO cost is near zero (the sitemap
has one URL, six weeks old). The one real cost is that `/api/submit` dies with the
Vercel deployment, which is what §1 and §2 below deal with.

---

## Status

| Step | State |
|---|---|
| 1. Waitlist form restored in theme | **Done** — committed and pushed |
| 2. Waitlist rows exported from Neon | **Done** — 13 real signups, CSVs in this directory |
| 3. Copy parity vs clippargolf.com | **Done** — section copy and footer match; render parity still unverified |
| 4. Email platform decision | **Done** — Sender retired, sending natively from Shopify (§2.1) |
| 5. Theme pushed + previewed | **Done** — pushed to unpublished `Clippar` #154528448706, verified rendering |
| 6. Store password protection removed | **Done** — turned off 2026-08-14; storefront is public on the myshopify URL |
| 7. Confirm `contact[tags]` sticks | **Done** — confirmed 2026-08-14, tags persist |
| 8. Import waitlist as Shopify customers | **Done** — see §2 |
| 9. Publish `Clippar` theme | **Done** — live on the myshopify URL 2026-08-14 |
| 10. Search Console Domain property | **Done** — verified 2026-08-14 via manual TXT |
| 11. DNS cutover | **Done** — completed 2026-08-14, verified end to end |

**clippargolf.com is live on Shopify.** Cutover completed 2026-08-14 ~06:18Z. Total
disruption: none observed — the apex answered 200 throughout.

Approach confirmed 2026-08-14: Shopify-native customer form, and Shopify as both the
system of record and the sending platform (not the Vercel endpoint, not Sender).

Verified on the dev server (`shopify theme dev`, or `preview_start` with the `clippar-shop`
entry in `clippar_app/.claude/launch.json`):

- Form renders with the clippargolf.com card styling, copy, placeholders and green button.
- Posts to `/contact` with `form_type=customer` and `contact[tags]=waitlist`.
- Closing CTA anchors to `#waitlist-form-section`; success state hidden until submit.
- Section copy and order match the live site end to end.
- Only console error is Shop Pay's `shop.app` iframe failing CSP `frame-ancestors` — an
  artifact of previewing on `localhost:9292`, gone once served from the real domain.

---

## 1. Waitlist capture on Shopify

`/api/submit` (Vercel → Neon Postgres → Sender.net) has no storefront equivalent. It
cannot be ported as-is: it needs a server to hold `SENDER_API_TOKEN`, and a Liquid theme
has nowhere to keep a secret.

**Replacement:** `snippets/waitlist-form.liquid` uses Shopify's native
`{% form 'customer' %}`. A signup becomes a Shopify customer with email-marketing
consent, tagged `waitlist` plus `plays-<frequency>`. Shopify is then both the list and
the sender, so there is no integration in the middle and no secret in the theme.

What changed in the theme:

- `snippets/waitlist-form.liquid` — new. Markup, element IDs and copy are identical to
  clippargolf.com, so `assets/clippar.css` applies unchanged.
- `sections/landing-hero.liquid` — `cta_mode` setting, defaulting to `waitlist`. The
  original port had replaced the form with a buy button. `product` mode keeps that
  version for when the app launches and the waitlist is retired.
- `sections/landing-cta.liquid` — same `cta_mode`; the closing button jumps to
  `#waitlist-form-section` like the live site, rather than to the product page.
- `assets/clippar.js` — restored the submit handler the port removed. It validates and
  folds the frequency answer into the tag list, then lets the browser submit natively.
  It must NOT intercept the submit — see the CAPTCHA finding below.

### How the frequency answer is carried

The play-frequency answer has no storage field on the customer form, so it is folded into
the customer tag list (`waitlist, plays-weekly`). Shopify **does** honour `contact[tags]`
on a customer-form submission — confirmed below.

Testing on 2026-08-14 proved the client side works — the hidden field is correctly
rewritten to `waitlist, plays-monthly` before submit — but surfaced two blockers in
sequence.

**1. Store password gate (fixed).** While password protection was on, every storefront
POST returned 403. Password protection has since been turned off, and the storefront now
serves at `/` without redirecting to `/password`.

**2. Shopify CAPTCHA on customer forms (design change).** With the gate off, the POST
returned `400 Missing CAPTCHA token`. Shopify's spam protection injects a CAPTCHA into
`{% form %}` submissions, and the original implementation hijacked the submit with an
async `fetch`, which skips that injection — so *every* signup would have failed silently
in production.

Fixed by removing the fetch interception: `clippar.js` now validates, folds the frequency
into the tag list, and lets the browser submit natively with the CAPTCHA token attached.
The success state moved inside the `{% form %}` block (where `form.posted_successfully?`
is actually in scope — it is not in scope outside it) and renders server-side after the
redirect.

**Cost of the fix:** submitting reloads the page instead of swapping the success state in
place, which is what clippargolf.com does. End state looks the same, it just arrives via
a round trip. Accepting that is much better than disabling spam protection on a public
waitlist form.

### Resolved — tags do persist

Confirmed 2026-08-14 with a real human submit (the invisible reCAPTCHA rejects synthetic
ones by design, so this step cannot be automated). Resulting customer record:

- Created by "Online Store", **Email subscription: Subscribed**
- **Tags: `waitlist`, `plays-weekly`** — both stuck

So `contact[tags]` is honoured on a customer-form submission, frequency segmentation
works, and the embedded-form fallback is **not** needed.

Housekeeping: that test record (`clippargolf@gmail.com`) was a real, subscribed customer.
It has been set to **Unsubscribed** (2026-08-14) so it cannot receive a send. Hard-delete
it if you want the record gone entirely.

---

## 2. Waitlist data

15 rows in Neon, `2026-03-29` → `2026-08-12`. Two are test entries
(`@test.com`, `@clippar.com`) — drop them, leaving **13 real signups**.

Frequency split: weekly 7, occasional 6, fortnightly 2.

Exported to:

- `waitlist_sender.csv` — `email, firstname, lastname, frequency, signup_date`
- `waitlist_shopify.csv` — Shopify customer-import columns, tagged `waitlist`

Re-run the export any time with `export_waitlist.py` (rows may have been added since).

**Imported 2026-08-14** via admin → Customers → Import. Result: **13 successful, 0 failed,
0 duplicates**. Both import options were left OFF — "overwrite existing" would have
clobbered the test record, and "add tags… to create a segment" adds a junk timestamp tag
to the batch rather than honouring the CSV's own Tags column (which applies regardless).

Verified in admin:

- `tag:waitlist` → 14 (the 13 imported plus the earlier form-submitted test record)
- `tag:plays-occasional` → 6, matching the CSV exactly
- All records show **Subscribed** email consent

**Consent note:** these people opted into a product waitlist, not a store newsletter.
Importing them as marketing-consented contacts is defensible, but the first send should
acknowledge where they signed up. Under the Spam Act consent doesn't expire, but the
oldest of these is ~5 months old.

**Do not drop the Neon table** until the contacts are confirmed in Shopify. Keep it
read-only as a fallback for at least one send cycle.

---

## 2.1 Email platform: Shopify native, Sender retired

Decided 2026-08-14.

The architecture already settles the system of record: signups become Shopify customers.
Sender was only ever going to *read* that list through its connector. So the real question
was which tool sends — and for 13 contacts with no automations planned, native wins:

- **No sync to maintain.** The Sender path needs an app plus a connector that can drift.
- **One consent record.** This is the one that actually bites — with two systems, someone
  who unsubscribes in one can still be mailed from the other. That is your liability under
  the Spam Act, and it is an easy mistake to make at low volume.
- **Segments run off the tags** already proven above (`plays-weekly`), with no field
  mapping.
- One fewer login, which is the point of the whole migration.

**What is given up:** Shopify's native email is the weaker tool — roughly three automation
templates, basic segmentation, no advanced branching or in-flow A/B testing, and slower
delivery above 1,000 recipients. Acceptable while the list is this size; automation depth
is not the bottleneck at 13 contacts.

**Why this is cheap to reverse:** Shopify stays the system of record, so switching to
Sender, Klaviyo or Omnisend later is just installing their connector — they all sync
Shopify customers natively. Revisit when abandoned-cart plus a real welcome sequence is
actually wanted.

### Reconciliation done 2026-08-14 — safe to close

Read Sender's subscriber list through the dashboard (the API token is scope-blocked from
`/v2/subscribers`). Sender holds **15**, Neon holds **15**. Diff:

| | |
|---|---|
| In Sender, not in Neon | `clippargolf@gmail.com` — Henry's own address, already a Shopify customer (the unsubscribed test record) |
| In Neon, not in Sender | `test@test.com` — a test row deliberately excluded from the export |

**Nothing real is stranded in Sender.** No engagement history is at stake either —
`GET /v2/campaigns` returns an empty list, so the account has never sent a campaign.
Safe to close whenever.

### Do this during the DNS cutover, not after

Sending as `@clippargolf.com` needs DKIM/SPF records. Since §3 already opens the Cloudflare
panel to repoint the apex, add the email-authentication records in the same pass. It saves
a second round trip and heads off the classic "first campaign lands in spam" problem.
Check **Settings → Notifications → Sender email** in Shopify admin for the exact records.

**Watch out — an SPF record already exists at the apex.** Cloudflare Email Routing has
already published:

```
clippargolf.com  TXT  "v=spf1 include:_spf.mx.cloudflare.net ~all"
cf2024-1._domainkey  TXT  "v=DKIM1; h=sha256; ..."
```

If Shopify asks for an SPF include, **merge it into the existing record** — do not add a
second SPF TXT. Two SPF records on one name is a permanent error under RFC 7208 and breaks
SPF for the whole domain, including the Cloudflare email routing that works today. The
merged form looks like:

```
v=spf1 include:_spf.mx.cloudflare.net include:<shopify-provided> ~all
```

Shopify's DKIM comes as its own CNAME/TXT on a distinct selector name, so that one does
not collide with the Cloudflare DKIM record above.

---

## 3. DNS cutover

Verified against Shopify's
[manual connection docs](https://help.shopify.com/en/manual/domains/add-a-domain/connecting-domains/connect-domain-manual),
August 2026.

### ROLLBACK — pre-cutover state, captured 2026-08-14T06:10:29Z

Site was serving 200 at this point. To revert, restore exactly:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `76.76.21.21` | DNS only |
| CNAME | `www` | `64a121cb65271fc8.vercel-dns-017.com` | DNS only |

No AAAA record existed at the apex — **delete the AAAA on rollback**, don't just edit it.
Leave both TXT records (Search Console + SPF) alone in either direction.

The Vercel project stays deployed, so restoring these two records is a complete rollback.

Current state:

```
clippargolf.com      A       76.76.21.21          (Vercel, not proxied)
www.clippargolf.com  CNAME   ...vercel-dns-017.com
nameservers          will.ns.cloudflare.com / june.ns.cloudflare.com
```

Target state — change in the Cloudflare dashboard:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `23.227.38.65` | **DNS only (grey cloud)** |
| AAAA | `@` | `2620:0127:f00f:5::` | **DNS only (grey cloud)** |
| CNAME | `www` | `shops.myshopify.com` | **DNS only (grey cloud)** |

Then in Shopify admin: **Settings → Domains → Connect existing domain** → `clippargolf.com`
→ Verify. Shopify provisions the TLS certificate itself, which takes up to 48h but is
usually minutes.

### The two things that will bite

1. **Proxy must be off.** The apex is currently unproxied, so this is a value change, not
   a mode change — but if any record gets set to the orange cloud, Shopify's certificate
   provisioning fails and the site serves an SSL error. Grey cloud on all three.
2. **Nameservers stay at Cloudflare.** Shopify's docs warn against "custom or external
   nameservers." That warning is about domains bought through Shopify; a third-party
   domain on Cloudflare DNS is a supported configuration. No change needed.

### What was actually done, 2026-08-14

Shopify's own **Manual setup** panel asked for only two record changes — **no AAAA**,
contrary to the generic docs table above. Followed Shopify's instructions:

| Type | Name | From | To | Proxy |
|---|---|---|---|---|
| A | `@` | `76.76.21.21` | `23.227.38.65` | DNS only |
| CNAME | `www` | `...vercel-dns-017.com` | `shops.myshopify.com` | DNS only |

Order used: **add the domain in Shopify first, then flip DNS.** That way Shopify already
recognised the domain when traffic arrived, instead of serving an unconfigured-store error
during the gap. Declined Shopify's "Connect automatically" for the same reason Google's
was declined — it wants access to the Cloudflare DNS account.

Post-cutover verification:

- `https://clippargolf.com/` → 200, serving theme `154528448706` (title `Clippar`,
  waitlist form present, glow gone, cart link present)
- `http://` upgrades to https; `https://www.` redirects to the apex
- `/sitemap.xml` → 200
- Search Console TXT intact, SPF count still 1, all 3 MX records intact
- Shopify admin: `clippargolf.com` **Primary / Connected**, `www` Connected and
  redirecting to the apex

Gotcha worth remembering: Cloudflare's inline edit row puts **Save below the fold** on a
short viewport — the first save silently does nothing. Always re-query authoritative DNS
after saving rather than trusting the UI.

Second gotcha: immediately after the change, a local `curl` still showed `server: Vercel`
from a stale connection even though every resolver already returned the Shopify IP. Use
`curl --resolve clippargolf.com:443:23.227.38.65` to test the real target rather than
chasing a phantom rollback.

### Ordering

Cut over only after the theme is published and verified on the `myshopify.com` URL.
Between the DNS change and certificate issuance the site can be briefly unreachable, so
do it at a low-traffic hour. It is reversible — put the Vercel A record back.

### Do not skip

- **Keep `public/google94a969fab3b3b1d7.html`.** It is the verification file for the
  existing Search Console URL-prefix property. Once the apex is on Shopify that file no
  longer serves, which silently breaks the property — hence the Domain property below.

  **Domain property created and VERIFIED 2026-08-14.** Verification method: Domain name
  provider (manual TXT). The record now live at the apex:

  | Type | Name | Content | TTL |
  |---|---|---|---|
  | TXT | `@` | `google-site-verification=c6TW6qODSaFj33sIeDQNswZxtaWX_rthZZUlW6cbaLQ` | Auto |

  **Do not remove that record** — verification is lost with it. Worth adding a second
  verification method under Settings → Ownership verification as insurance, since the
  apex is about to be repointed.

  A first Verify attempt failed with "couldn't find your verification token" — that was
  not propagation, the record simply had never been saved. Diagnose this class of problem
  by querying the authoritative nameservers directly rather than trusting the dashboard
  or waiting on propagation:

  ```bash
  dig +short TXT clippargolf.com @will.ns.cloudflare.com
  ```

  Adding it alongside the existing apex TXT is fine — **multiple TXT records on one name
  are legal.** The thing that is not legal is two *SPF* records, which matters below.
  SPF count was re-checked after adding this record and is still 1.

  Note: Search Console offered to auto-verify by **authorising Google to access the
  Cloudflare DNS account** via OAuth. That was declined deliberately — it grants Google
  standing access to DNS, and the manual TXT record achieves the same result. Use
  "Any DNS provider" in the instructions dropdown to get this manual path.
- **Keep the Vercel project deployed** (just no longer the domain target) until the
  Shopify site has been live and correct for a week. Cheapest possible rollback.
- Submit Shopify's `/sitemap.xml` in Search Console after cutover.
- Password protection is already off (done 2026-08-14), so the domain will not hit a
  password gate.
- **Publish the `Clippar` theme first.** `Horizon` is still the live theme; if DNS changes
  before publishing, `clippargolf.com` serves Shopify's default starter theme.

---

## 4. What is blocked, and on what

### Shopify CLI session expired

`shopify theme list` returns `401 Invalid API key or access token`. Nothing can be pushed
or previewed until this is re-authenticated.

**Decided:** Henry re-auths the CLI himself. In an interactive terminal (it opens a
browser):

```bash
shopify auth logout && shopify theme list --store=0zegsv-ef.myshopify.com
```

Consequence: the session expires again on its own schedule, and there is no Admin API
token, so the customer import in step 5 goes through Shopify's CSV upload rather than the
API. If that becomes annoying, the alternative is a custom app under
**Settings → Apps and sales channels → Develop apps** with
`read_themes, write_themes, read_customers, write_customers`, exported as
`SHOPIFY_CLI_THEME_TOKEN` — that does not expire with a browser session.

### Sender API token is scope-restricted — no longer blocking

The token in `.env` authenticates (`GET /v2/campaigns` → `200`) but `/v2/subscribers`,
`/v2/groups` and `/v2/account` all return `403 Access blocked`. That blocked the original
plan to import via Sender's API.

**Moot as of the §2.1 decision** — the import goes into Shopify instead. The token only
matters now if you want to export Sender's existing subscribers for the reconciliation
noted in §2.1, which needs a token with subscribers scope.

### Domain connection is not an API operation

Shopify has no public Admin API mutation for connecting a custom domain. Step 3 is
dashboard-only regardless of tokens — Cloudflare's side could be scripted with a
Cloudflare API token, but with three records it is not worth it.

---

## 5. Order of operations

Done:

1. ~~Re-auth Shopify.~~
2. ~~`shopify theme push` → preview on the `myshopify.com` URL.~~
3. ~~Test waitlist signup; confirm the customer and the `plays-*` tag.~~
4. ~~Remove store password protection.~~
5. ~~Import `waitlist_shopify.csv` as Shopify customers.~~

6. ~~Neutralise the `clippargolf@gmail.com` test customer~~ — set to **Unsubscribed**
   rather than deleted, so it cannot receive a send. Hard-delete it if you want it gone.
7. ~~Reconcile Sender against the 13~~ — done, nothing stranded (§2.1).
8. ~~Publish the `Clippar` theme.~~ Live on the myshopify URL since 2026-08-14.
9. ~~Create the Search Console Domain property.~~ Created; **verification pending** on the
   TXT record in §3.

10. ~~Add the Search Console TXT record and verify.~~ Done 2026-08-14.
11. ~~Flip the DNS records and connect the domain in Shopify admin.~~ Done 2026-08-14 —
    apex and www both live, TLS provisioned.

12. ~~Shopify email authentication.~~ Done 2026-08-14 — see §4 below.
13. ~~Submit the sitemap.~~ Done 2026-08-14; Google re-read it and now reports type
    **Sitemap index**, confirming it is reading Shopify's version rather than the old
    Vercel one.

Remaining:

14. **Verify checkout end to end** with a real card, once a product is ready to sell.
    Not something the agent can do — placing an order is a purchase.
15. Leave the Vercel project deployed for ~a week as rollback, then retire it. The old
    `clippar-web/` waitlist endpoint no longer receives traffic.
16. Watch for Shopify email auth to flip from "Propagation in progress" to
    **Authenticated**, and verify the sender address (see §4).

**Correction to earlier advice:** adding a *second* Search Console verification method is
not possible for a Domain property — DNS TXT is the only method Google supports for them.
The protection is simply: do not delete that TXT record. The old URL-prefix property was
verified by an HTML file that no longer serves post-cutover, so it will likely drop out of
verification on its own; harmless, since the Domain property supersedes it.

---

## 4. Shopify email authentication — done 2026-08-14

**The SPF merge warned about in §2.1 turned out not to apply.** Shopify does not ask for an
SPF include at all — it uses CNAME-based DKIM plus custom return-path subdomains
(`mailertsw`, `mailergam`), which carry their own SPF via delegation. The existing
Cloudflare Email Routing SPF record was left untouched, and the SPF count is still 1.

**Sender address.** Was `clippargolf@gmail.com`, which Shopify cannot authenticate at all —
public domains don't support custom sending, so customers would have seen
`store+76868681922@shopifyemail.com`. Changed to **`henry@clippargolf.com`**.

That address was not an arbitrary choice. Cloudflare Email Routing has exactly **one active
route** — `henry@clippargolf.com` → `henryjohncoward@gmail.com` — and the **catch-all is
Disabled (Drop)**. So `hello@`, `support@` or `orders@` would have silently discarded every
customer reply. If a less personal address is wanted, add the routing rule first, then
change the sender.

The address shows **Unverified** until the confirmation email Shopify sent to it is
actioned; it routes to `henryjohncoward@gmail.com`.

Six CNAME records added, all DNS-only:

| Name | Value |
|---|---|
| `tsw._domainkey` | `dkim1.71c7ab9a65e3.p479.email.myshopify.com` |
| `tsw2._domainkey` | `dkim2.71c7ab9a65e3.p479.email.myshopify.com` |
| `pdk1._domainkey.mailergam` | `dkim3.9356d00f962a.p705.email.myshopify.com` |
| `pdk2._domainkey.mailergam` | `dkim4.9356d00f962a.p705.email.myshopify.com` |
| `mailertsw` | `71c7ab9a65e3.p479.email.myshopify.com` |
| `mailergam` | `9356d00f962a.p705.email.myshopify.com` |

All six verified resolving from Cloudflare's authoritative nameservers. Shopify now reports
**"Propagation in progress"** (was "Needs setup") and will flip to **Authenticated** on its
own — quoted as up to 48h, usually far less.

**Tooling note:** Cloudflare's Add-record dialog is extremely flaky under automation — it
closes itself mid-entry, and its layout shifts depending on whether "Record Attributes" is
expanded, so fixed coordinates drift. Three records were lost to this before switching to
**DNS → Import** with a BIND zone file, which added the rest in one shot. Use Import for
any bulk record work here, and leave "Proxy imported DNS records" unchecked for mail.

Cloudflare DNS writes were initially blocked by the permission classifier; Henry allowed
them on 2026-08-14, and the Search Console TXT record was added that way. So step 11 is
drivable from here too — but it is the one genuinely disruptive step, so do it with Henry
present rather than unattended.
