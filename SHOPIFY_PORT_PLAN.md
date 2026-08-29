# Clippar → Shopify Theme Port Plan

**Status:** research + planning only. No code written. No changes to existing files.
**Date:** 2026-07-29
**Store handle:** `0zegsv-ef.myshopify.com`
**Existing site:** `clippar-web/` static → Vercel → `clippargolf.com`

---

## 0. Headline findings (read this first)

Three things materially change the shape of this project:

1. **The stated goal — merchant-of-record — is not achievable via Shopify for an Australian
   business.** Shopify Managed Markets (Global-e as MoR) is restricted to merchants based in the
   continental United States, with early access in Canada and the UK. Australia appears in the docs
   only as a *destination* country. Verified at
   [Managed Markets requirements](https://help.shopify.com/en/manual/international/managed-markets/requirements-and-considerations).
   What you *can* get from Shopify as an AU merchant is multi-currency, market pricing, and
   duties-at-checkout — but **you remain the merchant of record and you remain liable for your own
   tax registrations**. See §6.
2. **Most of `index.html` should not be ported.** It is a waitlist funnel, not a store. Porting the
   hero/waitlist/demo/library sections into Liquid creates a duplicate-content problem and doubles
   your maintenance surface for zero commercial gain. What should be ported is the **design system
   and page chrome** so the store feels continuous, plus the one section that genuinely sells
   hardware (the "How it works" carousel). See §2 and §3.
3. **The SEO risk of the subdomain split is close to zero — because there is almost nothing to
   protect.** `sitemap.xml` contains exactly one URL, `lastmod` 2026-06-24. This is a weeks-old
   single-page site. Treat the domain decision as a *product* decision, not an SEO-preservation
   decision. See §6.

---

## 1. Inventory of `clippar-web/public/index.html`

Single file, **1,673 lines**: ~815 lines of inline CSS in `<head>`, ~365 lines of markup, ~410
lines of inline `<script>` at the bottom. No build step, no dependencies, no framework.

### 1.1 Head / SEO block (lines 1–79)

| Item | Value |
|---|---|
| `<title>` | `Clippar — AI Golf Highlight Reels \| Every Shot, Remembered` |
| `meta description` | 197 chars, ends "Join the waitlist." |
| `meta keywords` | 8 terms, golf-video-intent |
| `meta theme-color` | `#07100a` |
| `link canonical` | `https://clippargolf.com/` |
| Favicons | `.ico`, `.svg`, 16/32 png, `apple-touch-icon.png` (180), `site.webmanifest` |
| Open Graph | `og:type=website`, `og:site_name`, `og:url`, `og:title`, `og:description`, `og:image` (1200×630), `og:image:alt`, `og:locale=en_US` |
| Twitter | `summary_large_image` + title/description/image/alt |
| JSON-LD | `@graph` with three nodes: `Organization` (`#organization`, email `clippargolf@gmail.com`, logo `icon-512.png`), `WebSite` (`#website`), `SoftwareApplication` (iOS/Android, `MultimediaApplication`) |
| Fonts | Google Fonts, one `<link>`: `Bebas+Neue`, `DM+Sans` (ital/opsz/wght 300;400;500 + italic 300), `DM+Mono` (400;500), `display=swap`, with `preconnect` to `fonts.googleapis.com` and `fonts.gstatic.com` |

### 1.2 Design tokens — `:root` (lines 82–95)

```
--bg:        #07100a    /* near-black green, page background */
--bg2:       #0d1a10    /* carousel dots strip, step video bg */
--bg3:       #111f14    /* select option background only */
--green:     #a8e63d    /* brand accent — the whole identity */
--green-dim: #6fa828    /* declared, never used in the file */
--white:     #f0f4ee    /* body text */
--muted:     #7a9178    /* secondary text */
--border:    rgba(168,230,61,0.15)
--card:      rgba(255,255,255,0.03)
--font-display: 'Bebas Neue', sans-serif
--font-body:    'DM Sans', sans-serif
--font-mono:    'DM Mono', monospace
```

Hard-coded values that escaped the token system and must be captured during the port:
`#c0f04f` (button hover), `#0a0a0a` (phone frame / gallery item bg), `#ff6b6b` + `rgba(255,80,50,…)`
(error state), `#ff5f57 / #febc2e / #28c840` (macOS traffic-light dots), `rgba(163,230,53,0.2)`
(mobile step-video glow — note this is a *different green* from `--green`, almost certainly a
copy-paste slip from Tailwind's `lime-400`).

Global styling: `box-sizing: border-box` reset, `html { scroll-behavior: smooth }`,
body `16px / 1.6` DM Sans, `overflow-x: hidden`.

### 1.3 Sections in document order

| # | Markup | Selector | Content |
|---|---|---|---|
| 1 | `<nav>` | `nav`, `.logo` | Fixed, centred, `CLIPPAR` in Bebas 28px green. `.logo-sub` and `.nav-tag` exist in CSS but are `display:none`. Has an iOS-Safari workaround: `transform: translateZ(0)`, `isolation: isolate`, and a `nav::before` pseudo-element extending `top:-100px` to cover status-bar bleed. |
| 2 | Hero | `.hero` | `min-height:100vh`. Eyebrow "Golf video, reimagined"; `<h1>` "Every shot. / **Remembered.**" at `clamp(64px,12vw,140px)`; sub-copy with `<strong>` on "cinematic highlight reel". Radial glow via `.hero::after` (800×800, `rgba(168,230,61,0.06)`). |
| 3 | Phone showcase | `.phone-showcase` / `.phone-frame` | Three 9:16 autoplay videos in a pyramid (`pos-left` / `pos-center` / `pos-right`), rotating clockwise every 5s. Each has a `.phone-label` (tag + desc) and a `.detection-badge`. Content: `demo_detected.mp4` / "AI Detection / Pose + skeleton tracking" / `POSE`; `demo_clean.mp4` / "Output / Clean trimmed shot" / `BALL + AUDIO`; `demo_raw.mp4` / "Multi-detect / Vision + audio fusion" / `VISION`. |
| 4 | Waitlist form | `.form-wrap` / `.form-card[data-glow]` | H2 "Join the waitlist", sub "Get founding member pricing…". Fields: `#f-name` (text), `#f-email` (email), `#f-frequency` (select: weekly/fortnightly/monthly/occasional). Button `SECURE MY SPOT`. Hidden `#form-error` and `#success` states. Footnote "No spam. Unsubscribe anytime…". |
| 5 | Count badge | `.count-badge` | Pulsing dot + "Waitlist open — spots filling fast". |
| 6 | How it works | `.section#how-it-works` / `.steps-carousel` | Label "How it works", title "Click. Swing. Clip." 3-slide carousel, 50/50 grid (copy \| video), with progress bar, prev/next arrows, dot indicators, swipe. **Steps 01 Click / 02 Swing / 03 Clip — this is the hardware sales pitch.** Step 1 names the phone mount, step 2 names the Bluetooth clicker. |
| 7 | Detection demo | `.demo-section` / `.demo-flow` | "Raw footage in. / Clean shots out." Two macOS-window-styled cards either side of a pulsing arrow. Left: fake `raw_footage/` file list (`IMG_3661.mov` 42 min, `IMG_3662.mov` 38 min, `IMG_3663.mov` 35 min). Right: `clippar_output/` with `demo_reel.mp4`, four `.output-tag` chips, and "14 shots detected" / "highlight_reel.mp4 2:30". |
| 8 | Shot gallery | `.gallery-section` | **Entirely commented out** (lines 1146–1196). CSS still present. Dead weight — do not port. |
| 9 | Tech strip | `.tech-strip` | Five `.tech-pill`s: YOLOv8 Pose, Ball Tracking, Audio Impact, 17 Keypoints, 1200Hz+ Filter. |
| 10 | Library | `.library-section` | 50/50 grid. Left: `.folder-stack` of four fake folders (Birdies & eagles 14 shots / Best rounds 8 rounds / The disasters 23 shots / Last 30 days 6 rounds). Right: "Every round. / Forever." + two paragraphs. |
| 11 | CTA repeat | inline-styled `<section>` | "Stop losing your **best shots.**" + anchor to `#waitlist-form-section`. Styling is fully inline including `onmouseover`/`onmouseout` colour swaps. |
| 12 | Footer | `<footer>` | `CLIPPAR` logo + `© 2025 Clippar · clippargolf@gmail.com`. Note: **copyright year is stale (2025)**. |

### 1.4 JavaScript behaviours (5 IIFEs / listeners)

1. **Phone carousel** (1264–1331) — `setInterval(rotateClockwise, 5000)`; swaps `anim-*` classes,
   `setTimeout(…, 1200)` to settle, tracks `positions[]`, guards re-entry with `isAnimating`.
2. **Spotlight glow** (1334–1351) — `mousemove` on every `[data-glow]`, sets `--glow-x/--glow-y/--glow-opacity`
   custom properties consumed by `::before` (300px radial) and `::after` (200px masked border).
   Pure hover effect; **no touch fallback** — dead on mobile.
3. **Form submit** (1354–1397) — `preventDefault`, client-side required check, `fetch('/api/submit')`
   POST JSON `{name,email,frequency}`, on `result.ok` hides the form and reveals `#success`.
4. **Scroll reveal** (1400–1414) — one `IntersectionObserver` at `threshold: 0.1` that sets
   opacity/transform on `.folder, .demo-card, .gallery-item, .tech-pill`. Note: it *only ever adds*
   visibility, never removes.
5. **Steps carousel** (1417–1574) — index state, `translateX(-N*100%)` track, dots, arrows,
   touch swipe (10px axis-lock, 50px threshold), progress bar timed to `video.duration`,
   auto-advance on `ended`, play/pause driven by an `IntersectionObserver` at `threshold: 0.3`.
6. **Aggressive video preload** (1577–1668) — forces `preload='auto'`, `muted`, `playsinline` and
   `.load()` on every `<video>`; seeks to `currentTime = 0.1` to avoid a black first frame; retries
   `play()` at 0ms/300ms/1000ms and again on first touch/click/scroll (iOS autoplay unlock);
   `IntersectionObserver` with `rootMargin: '200px'` to pause offscreen video.

Aggregate: this file contains an unusual amount of hard-won iOS Safari workaround. **Do not
"clean it up" during the port** — the `translateZ(0)` on nav, the `currentTime = 0.1` seeks, and
the multi-retry `play()` all exist for real reasons.

### 1.5 Assets

`clippar-web/public/landing_assets/` — **25 MB total**.

| File | Size | Used? |
|---|---|---|
| `steps/step2_swing.mp4` | **18 MB** | yes (step 2) |
| `steps/step1_click.mp4` | 1.8 MB | yes |
| `demo_reel.mp4` | 1.6 MB | yes |
| `steps/step3_clip.mp4` | 968 KB | yes |
| `demo_raw.mp4` | 672 KB | yes |
| `demo_detected.mp4` | 624 KB | yes |
| `demo_clean.mp4` | 480 KB | yes |
| `steps/step{1,2,3}_poster.jpg` | 148/84/140 KB | yes |
| `demo_swing_detected.mp4` | 184 KB | **no** |
| `demo_vision.mp4` | 156 KB | **no** |
| `demo_annotated.mp4` | 112 KB | **no** |
| `hero_*.jpg` ×4 | 32–56 KB | **no** |

Seven orphaned files. Also note `step2_swing.mp4` at 18 MB is by itself a third of Shopify's
50 MB compressed theme-package limit — see §4.6.

### 1.6 Backend — `api/submit.py`

Vercel Python serverless function (`BaseHTTPRequestHandler`). On POST it:
1. parses JSON `{name, email, frequency}`, requires name + email;
2. `INSERT … ON CONFLICT (email) DO UPDATE` into a `waitlist` table in **Neon Postgres** (`DATABASE_URL`);
3. best-effort POST to **Sender.net** `/v2/subscribers` with `firstname`, `groups:[SENDER_GROUP_ID]`,
   `fields:{frequency}` — wrapped in a bare `except: pass`, 5s timeout;
4. returns `{"ok": true}`.

Also implements `do_OPTIONS` with `Access-Control-Allow-Origin: *`. Deps: `psycopg2-binary`, `requests`.

This is **waitlist capture, not commerce**. Shopify does not replace it.

### 1.7 `vercel.json`

Empty `buildCommand`, `outputDirectory: "public"`, a no-op-looking rewrite `/api/(.*) → /api/$1`,
and a one-year `immutable` cache header on `/landing_assets/(.*)`.

---

## 2. What maps onto Shopify sections — and what does not

### Maps cleanly

| Site element | Shopify equivalent | Notes |
|---|---|---|
| `:root` tokens | `config/settings_schema.json` colour + font settings, emitted as a `:root` block in `theme.liquid` | Straight port. |
| `<nav>` | `sections/header.liquid` inside `sections/header-group.json` | Gains a cart link + count. |
| `<footer>` | `sections/footer.liquid` inside `sections/footer-group.json` | Gains policy links (required, see §5.5). |
| Steps carousel | `sections/steps-carousel.liquid` with `{% schema %}` blocks (`max_blocks: 6`) | Best 1:1 fit in the whole file. Each step = one block with `step_number`, `heading`, `richtext`, `video` (`video` setting type), `poster` (`image_picker`). |
| Tech strip | `sections/tech-strip.liquid` with text blocks | Trivial. |
| CTA repeat | `sections/cta-banner.liquid` | Trivial; move the inline styles into the section's `{% stylesheet %}`. |
| Section divider | `snippets/section-divider.liquid` | Trivial. |
| `[data-glow]` spotlight | `snippets/glow-card.liquid` + `assets/glow.js` | Behaviour is generic; wrap it. |
| Fake folder stack / library | `sections/feature-split.liquid` (image-or-custom side + text side) | Generalise rather than port verbatim. |
| Detection demo | `sections/pipeline-demo.liquid` | Portable but see below — probably shouldn't be on the store. |

### Maps awkwardly

| Element | Problem | Resolution |
|---|---|---|
| **Fonts** | Shopify's `font_picker` only serves the **Shopify font library**, which does **not** include Bebas Neue. You cannot express this brand through `font_picker`. | Self-host `.woff2` in `assets/`, reference with `{{ 'BebasNeue.woff2' \| asset_url }}` in an `@font-face`. Better than the current Google Fonts request anyway (removes a third-party connection, improves LCP). *Unverified:* check Bebas Neue's OFL terms permit self-hosting — it is an SIL-licensed font, which normally does. |
| **Phone showcase** | Three fixed `<video>` elements with an index-tracked CSS-keyframe rotation. Absolute `left: calc(50% ± Npx)` positions are hard-coded per breakpoint; making them merchant-editable means regenerating keyframes from settings. | Port it as a **fixed 3-item section with no schema blocks**. Do not make it configurable. It is a bespoke animation, not a content module. |
| **Videos** | 25 MB of `.mp4`, one file at 18 MB. Theme package limit is **50 MB compressed** ([theme limits](https://shopify.dev/docs/storefronts/themes/architecture/limits)). Shopify's own docs do not publish a per-asset size limit for `assets/`. | Do **not** put video in `assets/`. Upload to **Content → Files** in admin and reference by URL, or attach as product media. Re-encode `step2_swing.mp4` first — 18 MB for a ~10s clip is 10–20× larger than it needs to be. |
| **JSON-LD** | Hand-written `@graph` with `SoftwareApplication`. Shopify themes must emit `Product` / `Offer` schema for the store pages. | Split: `snippets/schema-org-org.liquid` for the Organization/WebSite nodes; a separate `snippets/schema-org-product.liquid` on the product template. Do not merge the app's `SoftwareApplication` node into product pages. |

### Does not map — and should not be ported

| Element | Why |
|---|---|
| **Waitlist form + `/api/submit`** | Shopify has no equivalent to a Neon-Postgres-plus-Sender.net endpoint. Shopify's newsletter form (`{% form 'customer' %}`) creates *Shopify customers*, which is a different data store and different consent semantics. Porting it would fork your waitlist across two databases. **Leave it on Vercel.** |
| **Hero + `<h1>`** | This is the marketing entry point and it lives at the canonical URL. Duplicating "Every shot. Remembered." on a Shopify subdomain creates two pages competing for the same query with no `rel=canonical` between them. |
| **Detection demo, library, tech strip, count badge** | Waitlist-funnel content. They sell the *app*. The Shopify store sells *hardware*. Different job. |
| **Commented-out gallery** | Dead code. Delete, do not port. |
| **`nav::before` iOS status-bar hack** | Specific to a `100vh` full-bleed hero on a fixed nav. Re-evaluate rather than transplant. |

---

## 3. Recommended base theme: **Skeleton**

**Recommendation: `Shopify/skeleton-theme` via `shopify theme init`.** Not Dawn. Not a purchased theme.

### Reasoning

**Against a purchased theme.** A paid theme is bought for its *design*. Clippar already has a
finished, opinionated, high-contrast dark visual identity that no marketplace theme resembles.
You would spend the entire budget deleting the theme's design, then be locked out of updates the
moment you touch its files, and be dependent on a third party's support queue. For a solo founder
with two SKUs this is the worst option on both cost and maintainability.

**Against Dawn.** Dawn ships roughly 30 sections, a large token/utility CSS system, and a
component architecture you did not write. You would be *subtracting* for days. Worse, the moment
you edit Dawn's files you can no longer take Dawn updates without a manual merge — the classic
solo-founder trap. Dawn's real value is breadth of merchandising features (predictive search,
complex filtering, product recommendation carousels, quick-add) that a two-SKU store will not use.

**For Skeleton.** It is Shopify's *official* minimal starting point, published May 2025
([changelog](https://shopify.dev/changelog/skeleton-theme-is-now-available)). It ships the same
eight canonical directories, uses JSON templates and modern theme blocks, and contains almost no
code you did not write. For a port whose source is a single hand-authored HTML file with bespoke
CSS, "every line is yours" is the right property. Total theme surface stays small enough that one
person holds it in their head.

**The honest counter-argument.** Skeleton makes you write the things Dawn gives you free and
tested: the **variant picker**, the **cart** (drawer or page), quantity handling, and
add-to-cart error states. These are the fiddliest, most accessibility-sensitive parts of a store
and the place where hand-rolled code most often breaks. Mitigation: read Dawn's implementations
of `product-form` / `variant-selects` / `cart-drawer` as reference before writing your own.
*Unverified:* confirm Dawn's `LICENSE` file permits reuse before copying any code verbatim —
check it rather than assuming.

**Fallback trigger.** If, four weeks in, you find yourself rebuilding cart/search/filtering rather
than shipping, switch to Dawn and accept the deletion work. Below ~10 SKUs that trigger should
never fire.

---

## 4. Theme file structure to build

Target: `clippar-shop/` as a **sibling of `clippar-web/`** in this repo (not nested inside it —
`vercel.json` sets `outputDirectory: "public"` and unrelated directories should stay out of that
project root).

```
clippar-shop/
├── .shopifyignore
├── .theme-check.yml
├── README.md
├── assets/
│   ├── base.css                  # reset, :root tokens, typography, buttons, form controls
│   ├── glow.js                   # [data-glow] spotlight — ported verbatim from index.html:1334-1351
│   ├── video-boot.js             # iOS autoplay unlock + first-frame seek — ported from :1577-1668
│   ├── cart.js                   # cart drawer state, /cart/add.js, /cart/change.js
│   ├── variant-picker.js         # variant selection → hidden input + price/media/CTA update
│   ├── noise.svg                 # extract the inline data: URI from body::before
│   ├── BebasNeue.woff2
│   ├── DMSans-{Light,Regular,Medium}.woff2
│   └── DMMono-{Regular,Medium}.woff2
├── blocks/                       # theme blocks — reusable across sections
│   ├── heading.liquid
│   ├── rich-text.liquid
│   ├── button.liquid
│   ├── feature-row.liquid        # icon + title + desc  (maps shop.tsx kit.items[])
│   └── pill.liquid               # maps SELLING_POINTS + .tech-pill
├── config/
│   ├── settings_schema.json
│   └── settings_data.json
├── layout/
│   ├── theme.liquid
│   └── password.liquid
├── locales/
│   ├── en.default.json
│   └── en.default.schema.json
├── sections/
│   ├── header.liquid
│   ├── header-group.json
│   ├── footer.liquid
│   ├── footer-group.json
│   ├── announcement-bar.liquid
│   ├── main-product.liquid
│   ├── main-collection.liquid
│   ├── main-cart.liquid
│   ├── main-page.liquid
│   ├── main-404.liquid
│   ├── steps-carousel.liquid     # ported from .steps-carousel
│   ├── kit-comparison.liquid     # Standard vs Premium table — new, no source equivalent
│   ├── selling-points.liquid     # SELLING_POINTS row from shop.tsx
│   ├── faq.liquid                # new — shipping/returns/compatibility
│   ├── cta-banner.liquid         # ported from the CTA repeat section
│   └── app-crosslink.liquid      # "Get the app" → clippargolf.com
├── snippets/
│   ├── meta-tags.liquid          # OG/Twitter/canonical — mirrors index.html:22-39
│   ├── schema-org-org.liquid     # Organization + WebSite nodes
│   ├── schema-org-product.liquid # Product + Offer + AggregateOffer
│   ├── section-divider.liquid
│   ├── glow-card.liquid
│   ├── price.liquid              # money_with_currency — must be currency-aware, see §6
│   ├── product-card.liquid
│   ├── icon.liquid               # inline SVG sprite (lucide set, matching shop.tsx icons)
│   └── responsive-image.liquid   # image_url + widths/sizes
└── templates/
    ├── index.json
    ├── product.json
    ├── product.kit.json          # alternate template for the kit product
    ├── collection.json
    ├── cart.json
    ├── page.json
    ├── page.faq.json
    ├── 404.json
    ├── search.json
    ├── customers/               # only if customer accounts are enabled
    └── metaobject/
```

### 4.1 `layout/theme.liquid`

The single required file for a theme to upload
([layouts](https://shopify.dev/docs/storefronts/themes/architecture/layouts)). Must contain
`{{ content_for_header }}` inside `<head>` and `{{ content_for_layout }}` inside `<body>` — Shopify
refuses to save the file otherwise, and `content_for_header` must never be parsed or modified.

Contents:
- `<html lang="{{ request.locale.iso_code }}">`
- `<meta name="theme-color" content="{{ settings.color_bg }}">`
- `@font-face` block (self-hosted woff2 via `asset_url`)
- `:root { --bg: {{ settings.color_bg }}; … }` generated from theme settings
- `{{ 'base.css' | asset_url | stylesheet_tag }}`
- `{% render 'meta-tags' %}` and `{% render 'schema-org-org' %}`
- `{{ content_for_header }}`
- `{% sections 'header-group' %}` / `{{ content_for_layout }}` / `{% sections 'footer-group' %}`
- deferred `<script src="…" defer>` tags for `glow.js`, `video-boot.js`, `cart.js`

Add `layout/password.liquid` now — you will want the store password-protected while building.

### 4.2 Section groups

Per [section groups](https://shopify.dev/docs/storefronts/themes/architecture/section-groups):
JSON data files in `sections/`, rendered by the `{% sections %}` tag, and Shopify's guidance is to
use them *only* for header and footer in most themes. Limits: 20 section groups per theme, 25
sections per group.

`sections/header-group.json` → `announcement-bar`, `header`.
`sections/footer-group.json` → `footer`.

### 4.3 Theme blocks vs section blocks

Use the `blocks/` directory for anything reused across sections
([theme blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks/theme-blocks)):
theme blocks live in `/blocks/*.liquid`, can nest, and are accepted by a section that declares
`"blocks": [{ "type": "@theme" }, { "type": "@app" }]` in its schema and renders them with
`{% content_for 'blocks' %}`. Section-defined blocks stay local to their section — use those for
the steps carousel's step blocks, which are meaningless elsewhere.

Limits to design against: 50 blocks per section (raise with `max_blocks`), 300 theme block files
per theme, 8 levels of nesting, 25 sections per JSON template.

### 4.4 `config/settings_schema.json`

Structure is an array of category objects, each with `name` and a `settings` array
([settings_schema.json](https://shopify.dev/docs/storefronts/themes/architecture/config/settings-schema-json)).
The `theme_info` object is special and **all** its attributes are mandatory when present:
`theme_name`, `theme_author`, `theme_version`, `theme_documentation_url`, and **exactly one** of
`theme_support_email` / `theme_support_url` — including both is an error. 512 KB file limit.

Keep this deliberately small. A solo founder does not benefit from a Dawn-scale settings surface.

```
[
  { "name": "theme_info", … },
  { "name": "Colors",    settings: color_bg #07100a, color_bg_alt #0d1a10,
                                   color_accent #a8e63d, color_accent_hover #c0f04f,
                                   color_text #f0f4ee, color_text_muted #7a9178 },
  { "name": "Typography", settings: font_size_base, heading_letter_spacing
                                   /* NOT font_picker — fonts are self-hosted, see §2 */ },
  { "name": "Social",     settings: social_instagram, social_tiktok, social_youtube },
  { "name": "SEO",        settings: og_image (image_picker), meta_description (textarea) },
  { "name": "App",        settings: app_store_url, play_store_url, marketing_site_url }
]
```

`config/settings_data.json` holds the chosen values (1.5 MB limit) and is what the theme editor
writes back to.

### 4.5 Templates

All JSON, referencing sections by name with per-instance settings. 512 KB each, 25 sections each.
`templates/product.kit.json` is an alternate product template selectable per-product in admin — use
it so the kit product page can carry `steps-carousel` + `kit-comparison` + `faq` while any future
accessory product uses the plain `product.json`.

### 4.6 Asset strategy

- **CSS**: one `base.css` for tokens/reset/typography/buttons; everything else in per-section
  `{% stylesheet %}` tags so styles ship only with the section that uses them.
- **JS**: no framework, no bundler. Port the existing IIFEs as-is into three files. Keep
  `video-boot.js` *verbatim* — every retry in it is load-bearing on iOS.
- **Video**: `assets/` is the wrong home. Upload to **Content → Files** and reference the CDN URL
  via a `video` or `url` setting, or attach to the product as media. The theme package limit is
  50 MB compressed and `step2_swing.mp4` alone is 18 MB. Re-encode before uploading anywhere.
- **Images**: use `image_url: width: …` + `srcset` via `snippets/responsive-image.liquid`; let
  Shopify's CDN do the resizing rather than shipping fixed JPEGs.
- **Noise grain**: extract the `feTurbulence` data-URI to `assets/noise.svg`. It is currently a
  URL-encoded SVG inline in CSS — fine in a `.css` file, but `%23` sequences are easier to lose than
  to keep.

---

## 5. Product setup

Source of truth for copy: `clippar_app/app/(tabs)/shop.tsx` (`KITS` at line 28, `SELLING_POINTS`
at line 70). Prices confirmed in `clippar_app/constants/config.ts`:
`standardPriceCents: 5900`, `premiumPriceCents: 6900`, `currency: 'aud'`.

### 5.1 Structure: one product, two variants

**Recommendation: a single product `Clippar Kit` with one option `Kit` and two variants
(`Standard`, `Premium`)** — not two separate products.

Why: `shop.tsx` already presents this as one selector with two choices, so the mental model matches;
one product = one URL = one page accumulating link equity and reviews; Standard → Premium is a
variant swap rather than a cross-sell; Shopify analytics keeps them grouped. The only cost is that
"What's included" differs per variant, which variant-scoped metafields handle cleanly (§5.3).

| Field | Standard | Premium |
|---|---|---|
| Title | Clippar Kit | Clippar Kit |
| Option `Kit` | Standard | Premium |
| Price | 59.00 AUD | 69.00 AUD |
| SKU | `CLPR-KIT-STD` | `CLPR-KIT-PRM` |
| Weight | *TBD — required for real shipping rates* | *TBD* |
| HS code | *TBD — required for duties at checkout, §6* | *TBD* |
| Country of origin | *TBD* | *TBD* |
| Variant image | mount + clicker | mount + clicker + charging pad |

HS code and country of origin are **built-in variant fields** (Shipping section), not metafields.
They are a hard prerequisite for duty calculation.

### 5.2 Copy mapping from `shop.tsx`

| `shop.tsx` | → Shopify |
|---|---|
| `"Clippar Kit"` (line 131) | Product title |
| `"Mount your phone, clip your shots, relive every round."` (134) | Product description, opening line |
| `standard.tagline` `"Everything you need to get started"` | Variant metafield `tagline` |
| `premium.tagline` `"Standard Kit + wireless charging convenience"` | Variant metafield `tagline` |
| `"BEST VALUE"` badge on premium (234) | Variant metafield `badge` (single_line_text_field) |
| `items[]`: Universal Buggy Mount / *"Adjustable clamp fits any golf buggy rail. Holds phones up to 6.9\"."* | `kit_component` metaobject entry, referenced per variant |
| `items[]`: BLE Shot Clicker / *"Belt-clip remote with 1-year CR2032 battery. One-tap shot marking."* | `kit_component` metaobject entry |
| `items[]`: MagSafe Charging Pad / *"15W wireless charger. Keep your phone topped up between rounds."* | `kit_component` metaobject entry — **Premium only** |
| `SELLING_POINTS[]`: `12-month clicker battery life`, `Designed for Australian courses`, `Free shipping Australia-wide`, `30-day satisfaction guarantee` | `selling_points` metafield (list.single_line_text_field), rendered by `sections/selling-points.liquid` |
| `"Free Shipping Australia-wide"` / `"Ships within 3 business days via Australia Post"` (320–324) | Shipping profile + FAQ page. **Note: "Free shipping Australia-wide" and "Designed for Australian courses" must be conditionalised once you sell internationally** — see §8. |
| `"Secure payment via Stripe"` (340) | **Delete.** Shopify checkout is not Stripe. |
| Product hero (a `Package` lucide icon on a surface, 138–160) | **There is no product photography yet.** This is a blocker — see §8. |
| `"Buy Now — $59 AUD"` | Add-to-cart button. Price must come from `{{ product.selected_or_first_available_variant.price \| money_with_currency }}`, never hard-coded. |

Steps 01/02/03 in `index.html` are the better hardware pitch than anything in `shop.tsx` — step 1
sells the mount, step 2 sells the clicker. Reuse that copy on the product page.

### 5.3 Metafields and metaobjects

**Metaobject definition `kit_component`** (this is the right shape — the three components are shared
entities, and Premium is Standard plus one):
- `icon` — single_line_text_field, keyed to `snippets/icon.liquid` (`smartphone`, `bluetooth`, `zap`)
- `title` — single_line_text_field
- `description` — multi_line_text_field

**Product-level metafields** (namespace `custom`):

| Key | Type | Source |
|---|---|---|
| `selling_points` | list.single_line_text_field | `SELLING_POINTS` |
| `in_the_box_note` | rich_text_field | new |
| `compatibility` | rich_text_field | `Holds phones up to 6.9"` — surface prominently |
| `app_required` | boolean | true — the kit needs the app |

**Variant-level metafields**:

| Key | Type | Standard | Premium |
|---|---|---|---|
| `tagline` | single_line_text_field | ✓ | ✓ |
| `badge` | single_line_text_field | — | `BEST VALUE` |
| `components` | list.metaobject_reference → `kit_component` | 2 refs | 3 refs |

Expose every one of these to the Storefront API so the theme can read them; Liquid access is
`{{ product.metafields.custom.selling_points.value }}`.

### 5.4 Collection

One collection, `Hardware`, containing the kit. Exists so the store has a browsable
`/collections/hardware` and so the nav has somewhere to point. Do not over-build.

### 5.5 Required policy pages

Non-negotiable before the store can accept a real order: Refund policy (must reflect the
"30-day satisfaction guarantee" claim already made in `shop.tsx`), Shipping policy, Privacy policy,
Terms of service, and Contact. Shopify generates templates for these in
Settings → Policies. They must be linked from `footer-group.json`.

### 5.6 Consequence for the mobile app — this needs a decision

The app currently runs its own hardware checkout: `shop.tsx` → `initPaymentSheet` →
`supabase/functions/create-payment-intent` (Stripe, AUD, `metadata.product_type`) →
`stripe-webhook` → a `hardware_orders` table read back by `getHardwareOrder()` in `lib/api.ts:610`.
Moving hardware to Shopify makes that path redundant. Options:

- **(a)** Replace the Shop tab with a link-out to `shop.clippargolf.com`. Apple explicitly requires
  this for physical goods — guideline **3.1.3(e)**: physical goods consumed outside the app *must*
  use payment methods other than IAP. Linking out is the sanctioned pattern, and no External
  Purchase Link entitlement is needed. Simplest, and `hardware_orders` / `create-payment-intent`
  can be retired.
- **(b)** Keep the Stripe path in-app *and* run Shopify on the web — two order systems, two
  fulfilment queues, two sources of inventory truth. Not recommended.
- **(c)** Keep the in-app UI but drive it through Shopify's Storefront API cart → web checkout.
  Most work, best UX.

The Shop tab is already hidden for the v1 App Store submission, so this decision is not blocking
the app release — but it should be made before the Shopify store goes public.

---

## 6. Domain and SEO: subdomain vs moving the whole site

### 6.1 The SEO-standing question, answered honestly

The stated fear — losing Google Search Console standing and rankings — does not really apply here.
`sitemap.xml` contains **one URL** with `lastmod` 2026-06-24. The site is a single-page waitlist
launched weeks ago. There is no ranking history, no backlink profile, and no internal link graph to
preserve. **Any** of the options below is safe on that axis.

One concrete mechanical issue does exist. Verification is via
`public/google94a969fab3b3b1d7.html`, which is an **HTML-file verification → a URL-prefix property**.
A URL-prefix property for `https://clippargolf.com/` does **not** cover `shop.clippargolf.com`.
Whatever you choose, you should:

1. Add a **Domain property** for `clippargolf.com` in Search Console (DNS TXT verification). It
   covers the apex and every subdomain and every protocol, which is what you actually want.
2. Keep the existing `google94a969fab3b3b1d7.html` file in place regardless — removing it silently
   breaks the old property.

### 6.2 Options

**(A) Subdomain — `shop.clippargolf.com` on Shopify, apex stays on Vercel.** *(user's proposal)*
DNS: a `CNAME` from `shop` → `shops.myshopify.com`, plus a `shopify_verification_shop` TXT record if
Shopify prompts for one
([connect a subdomain](https://help.shopify.com/en/manual/domains/add-a-domain/connecting-domains/connect-subdomain)).
No A record needed. Note Shopify requires you to own the root domain before adding a subdomain — you do.

- Marketing site untouched; `/api/submit` and the waitlist keep working with zero changes.
- Fully reversible. Ships fastest.
- Cost: two analytics properties, two consent banners, split first-party cookies (a visitor's
  marketing-site session does not follow them into checkout), two deploy pipelines.
- Shopify Markets can still do per-market URLs beneath the subdomain (`shop.clippargolf.com/en-gb`).

**(B) Move everything to Shopify at the apex.** `clippargolf.com` becomes the Shopify primary
domain and `templates/index.json` becomes the landing page.

- One domain, one authority pool, one analytics property, one cookie jar, one codebase.
- Kills `/api/submit`: the Neon `waitlist` table and Sender.net sync have no Shopify equivalent that
  preserves the existing data. You would either keep a Vercel deployment purely for the API (and
  hit CORS from a different origin — the handler already sends `Access-Control-Allow-Origin: *`,
  so it would work), or migrate the waitlist to Shopify customers + a marketing app and abandon the
  existing rows.
- Forces the full port of hero/demo/library into Liquid — the work §2 argues against.

**(C) Reverse split — Shopify at apex, marketing at `www` or `app.`** Worst of both. Discounted.

### 6.3 Recommendation

**Go with (A), the subdomain, and treat it as the destination rather than a stepping stone.**

Rationale beyond the low SEO stakes: the two properties have genuinely different jobs and different
change cadences. The marketing site is a waitlist funnel for an app that hasn't launched; the store
sells two SKUs of accessory hardware. Coupling them means every landing-page copy tweak becomes a
`shopify theme push`. Keeping the Python waitlist endpoint on Vercel, untouched and working, is
worth more than domain consolidation at this stage.

Revisit (B) only if **both**: the app has launched (so the waitlist funnel is retired and
`/api/submit` is dead weight anyway), and hardware becomes a primary revenue line rather than an
app accessory. At that point the port cost is lower because the waitlist blocker is gone.

**Do these regardless of choice:**
- Add the Search Console **Domain property** (§6.1).
- Add `shop.clippargolf.com` to `robots.txt`'s sitemap list, or better, let Shopify serve its own
  `/sitemap.xml` on the subdomain and register it as a separate sitemap in the Domain property.
- Cross-link both directions: a "Shop the kit" nav item on the marketing site, a "Get the app"
  section (`sections/app-crosslink.liquid`) on the store.
- Set `og:site_name` to `Clippar` on both, and give the store its own `og:image` — do not reuse the
  app's `og-image.png` on product pages.
- Point the store's `Organization` JSON-LD `@id` at `https://clippargolf.com/#organization`, the
  same node the marketing site declares, so both sites resolve to one entity.

### 6.4 International selling — recalibrate expectations

This is the stated reason for the whole project, so be precise about what Shopify does and does not
deliver to an **Australian** merchant. All figures verified July 2026; re-check in admin before
pricing, as Shopify changes these often.

| Capability | Available to an AU merchant? | Detail |
|---|---|---|
| **Merchant of record (Managed Markets / Global-e)** | **No** | Continental US only; Canada and UK in early access. Australia is a destination country, not a merchant country. [requirements](https://help.shopify.com/en/manual/international/managed-markets/requirements-and-considerations) |
| **Shopify Markets** (multi-currency, market pricing, per-market domains) | Yes | Included on all paid plans. Market count is plan-dependent (~3 on Basic/Grow). [Markets](https://help.shopify.com/en/manual/markets) |
| **Shopify Payments multi-currency** | Yes | AU is a Shopify Payments country. **Currency conversion fee 2%** for AU-based stores (vs 1.5% US). |
| **Duties + import taxes at checkout** | Yes | The Advanced-plan restriction was **removed 2 Feb 2025** — now on all plans. Fee temporarily **0.5%**, standard rates 0.85% (Shopify Payments) / 1.5% (other). Requires HS codes. [charging duties](https://help.shopify.com/en/manual/international/duties-and-import-taxes/charging-duties) |
| **Shopify Tax** | Calculation + filing assistance only | Shopify is **never** your merchant of record for tax. You register, you remain liable. |
| **IOSS (EU ≤ €150)** | Your own registration | At $59–69 AUD both kits sit well under the €150 threshold. Registration is optional but required to charge VAT at checkout on EU orders. |

**Net:** Shopify gets you multi-currency, market pricing, and duties collection. It does **not**
get you out of tax liability. Budget roughly **2% FX + 0.5–1.5% duty calculation** on top of payment
processing for international orders — material on a $59 item. If MoR coverage is genuinely the
priority, a third-party MoR that accepts AU merchants is a separate evaluation, outside this plan.

---

## 7. Shopify CLI workflow

### 7.1 Prerequisites

- Node.js (current LTS) and Shopify CLI: `npm install -g @shopify/cli@latest`
- VS Code + the official **Shopify Liquid** extension (schema autocomplete, Theme Check inline)
- Store owner, staff with **Manage themes**, or collaborator access on `0zegsv-ef`

### 7.2 Authentication — two paths

**Interactive (use this for local development).** `shopify theme dev` triggers a browser OAuth flow
on first run; the CLI stores the session. Requires store-owner, or a staff/collaborator account with
"Manage themes". Note: `shopify auth logout` **deletes your development themes** — don't log out
mid-session expecting the dev theme to persist.

**Token (use this for CI, or to avoid granting full admin).** Install the free **Theme Access** app
from the Shopify App Store and generate a password. It is scoped to `write_themes` only. The
password is emailed as a link valid 7 days or until first viewed. Supply it as
`SHOPIFY_CLI_THEME_TOKEN` in CI, or `--password` on the command line
([Theme Access](https://shopify.dev/docs/storefronts/themes/tools/theme-access)).

### 7.3 Commands

```bash
# ── one-time scaffold ───────────────────────────────────────────
shopify theme init            # prompts for a name; defaults to Skeleton
cd clippar-shop

# ── daily loop ──────────────────────────────────────────────────
shopify theme dev --store 0zegsv-ef
#   uploads a *development* theme (invisible in the theme library to others)
#   serves at http://127.0.0.1:9292
#   returns: dev theme URL, theme-editor URL, shareable preview URL
#   hot-reloads CSS and sections by default
#   --live-reload full-page | off      to change reload behaviour
#   --only / --ignore <pattern>        to scope which files trigger reloads
#   ⚠ checkout customisations are NOT previewable at 127.0.0.1:9292

shopify theme check           # Theme Check linter — run before every push

# ── first upload to the real library ────────────────────────────
shopify theme push --unpublished    # prompts for a theme name

# ── subsequent uploads ──────────────────────────────────────────
shopify theme push --theme <id>     # always target by ID; never rely on the default
shopify theme list                  # theme names, IDs, statuses

# ── go live ─────────────────────────────────────────────────────
shopify theme publish --theme <id>

# ── pull merchant edits made in the admin theme editor ──────────
shopify theme pull --theme <id> --only templates/*.json config/settings_data.json
```

### 7.4 The rule that will bite you

`templates/*.json`, `sections/*-group.json`, and `config/settings_data.json` are **written by the
theme editor in the admin**. If you edit those in the admin and then `shopify theme push`, your
local versions overwrite the merchant edits silently. Two safeguards:

1. Put this in `.shopifyignore` so ordinary pushes never clobber merchant data:
   ```
   config/settings_data.json
   ```
   Push it explicitly with `--only` when you intend to.
2. Before any push after admin work, run
   `shopify theme pull --only templates/*.json config/settings_data.json` and commit the result.

`shopify theme dev` never touches the live theme — it only ever writes to a development theme —
so it is always safe to run.

### 7.5 Git

Commit `clippar-shop/` into this repo alongside `clippar_app/` and `clippar-web/`. Add
`clippar-shop/node_modules` and `clippar-shop/.shopify` to `.gitignore`. Branch per feature; the
live theme is the deploy target, so treat `shopify theme publish` as the release action.
Optionally connect **GitHub integration** in Shopify admin (Online Store → Themes → Add from GitHub)
so a branch auto-syncs — but note it two-way syncs and can produce commits you did not author.

---

## 8. Open questions — decide before build starts

**Blocking (cannot ship a store without these):**

1. **Product photography.** There is none. `shop.tsx` renders a lucide `Package` icon on a surface
   as the product hero; `landing_assets/` has no hardware images at all. A store selling $59 hardware
   with no product photos will not convert. Who shoots this, and when?
2. **Does the hardware physically exist and is it in hand?** Shopify inventory, weights, HS codes,
   and country of origin all require real units. If this is pre-production, the store should be a
   pre-order and the copy must say so.
3. **Shipping.** `shop.tsx` promises "Free shipping Australia-wide" and "Ships within 3 business
   days via Australia Post" — is that real and currently true? What are international rates, and
   does "free shipping" survive contact with international postage on a $59 item?
4. **App checkout decision** (§5.6 a/b/c). This determines whether
   `supabase/functions/create-payment-intent`, the `stripe-webhook` handler, and the
   `hardware_orders` table get retired or kept.

**Important (shape the build):**

5. **Domain: confirm (A) subdomain, or override to (B)?** §6.3 recommends (A). This is the single
   decision with the widest blast radius on the file structure.
6. **Given Managed Markets is unavailable to you (§0.1, §6.4) — is Shopify still the right choice?**
   The stated driver was merchant-of-record. Shopify still wins on multi-currency, duties, checkout
   quality, and fulfilment tooling, but the MoR premise should be consciously re-affirmed rather
   than assumed.
7. **Which markets at launch?** AU only, AU+NZ, or AU+NZ+US+UK+EU? This decides plan tier (market
   count), whether duties need enabling, and whether HS codes are urgent or can wait.
8. **"Designed for Australian courses" and "Free shipping Australia-wide"** — both are in
   `SELLING_POINTS`. Neither survives internationalisation. Rewrite, or make them market-conditional
   via Markets content localisation?
9. **Shopify plan.** Basic (AUD $56/mo, 1.75% + 30c) is almost certainly right at launch. Confirm.
10. **Waitlist and the store.** Should `shop.clippargolf.com` also capture waitlist signups, or does
    it stay purely transactional? If it captures, does it write to Neon via CORS to the existing
    `/api/submit`, or create Shopify customers? Two databases is the wrong answer.
11. **Customer accounts** — on or off? Off is simpler and removes `templates/customers/` entirely.
    On is needed if you ever want order history or to link app identity to store identity.
12. **One product two variants (recommended, §5.1) or two products?** Confirm before metafields are
    defined, since variant-scoped metafields depend on it.

**Lower priority:**

13. Delete the seven orphaned files in `landing_assets/` (§1.5)?
14. Re-encode `step2_swing.mp4` (18 MB) before it goes anywhere near Shopify?
15. The footer copyright still reads **© 2025** — fix in the port.
16. `--green-dim: #6fa828` is declared and never used, and `rgba(163,230,53,…)` in the mobile
    step-video rule is a *different* green from `--green`. Reconcile or drop during the token port.
17. The `[data-glow]` spotlight has **no touch fallback**. Most store traffic will be mobile. Add
    one, or accept it as desktop-only polish?
18. Product reviews — Shopify Product Reviews, Judge.me, or none at launch?

---

## 9. Suggested build order

| Phase | Work | Output |
|---|---|---|
| 0 | Decide §8 items 1–7 | Unblocked |
| 1 | `shopify theme init` (Skeleton); `theme.liquid`, tokens, self-hosted fonts, `base.css`, header/footer groups, password layout | Store shell live, password-protected, brand-correct |
| 2 | Product + variants + metaobjects + metafields in admin; policy pages; shipping profile | Data model complete |
| 3 | `main-product.liquid`, variant picker, cart, `snippets/price.liquid` | Buyable |
| 4 | Port `steps-carousel`, `selling-points`, `kit-comparison`, `faq`, `cta-banner`, `glow.js`, `video-boot.js` | Store matches brand |
| 5 | DNS `CNAME shop → shops.myshopify.com`; Search Console Domain property; cross-links; Markets + duties config | Public |

---

## 10. Verified vs unverified

**Verified against live shopify.dev / help.shopify.com (July 2026):** theme directory structure
(8 directories); `theme.liquid` requiring `content_for_header` + `content_for_layout`; section
groups as JSON in `sections/` rendered by `{% sections %}`, header/footer only, 20 per theme;
theme blocks in `blocks/` with `@theme`/`@app` and `{% content_for 'blocks' %}`;
`settings_schema.json` structure and mandatory `theme_info` attributes; theme limits (50 MB
compressed package, 512 KB JSON templates, 256 KB Liquid files, 25 sections/template, 50
blocks/section, 300 theme blocks); Skeleton theme existence and `shopify theme init` flow; CLI
commands `dev` / `push` / `pull` / `init` / `check` / `publish` / `list` / `share`, the
`--live-reload` / `--only` / `--ignore` / `--password` flags, `127.0.0.1:9292`, checkout not
previewable, dev themes deleted on logout; Theme Access app scoped to `write_themes` and
`SHOPIFY_CLI_THEME_TOKEN`; subdomain connection via `CNAME → shops.myshopify.com` + optional
`shopify_verification_*` TXT; Managed Markets restricted to continental US / CA / UK early access;
duties available on all plans since 2 Feb 2025; Apple guideline 3.1.3(e).

**Not verified — check before relying on:**
- Per-asset file size limit for `assets/` — Shopify does not publish one. Only the 50 MB compressed
  package limit is documented.
- Whether the temporary **0.5%** duty-calculation fee is still in effect (the doc gives no end date).
  Standard rates are 0.85% / 1.5%.
- Exact market counts per plan tier — sourced from a Shopify developer-community thread, not a help
  doc. Verify in your admin.
- Whether AU-based merchants can enable **Shopify Tax** — no explicit statement found either way.
- Dawn's `LICENSE` terms for reusing its cart/variant-picker code.
- Bebas Neue's licence terms for self-hosting.
- Current AUD plan pricing (Basic $56/mo etc.) — from shopify.com/au/pricing, subject to change.
- Nothing in this plan was verified against the actual store `0zegsv-ef` — as instructed, no login
  or store modification was attempted.
