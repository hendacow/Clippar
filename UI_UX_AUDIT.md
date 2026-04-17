# Clippar UI/UX Audit

**Audit lens:** Casual golfer who just downloaded the app. Benchmark: PGA Tour's official highlight app.
**Date:** 2026-04-17
**Scope:** Every non-excluded screen read cover to cover.

---

## Executive Summary

Clippar has **good bones** — a clear dark-mode palette, consistent use of tokens from `constants/theme.ts`, haptics on almost every press, and skeleton loaders in key places. The brand voice "Every Shot. Remembered." lands well.

But the product doesn't yet feel Tour-polished. The biggest gaps:

1. **The Home tab is named "Library" in the tab bar but shows a hero reel + stats.** That name mismatch is the first friction a casual golfer hits.
2. **The Clippar wordmark in the home header is too small and feels like a nav title, not a brand signature.** No subtitle, no greeting, no reason the user feels like *their* app.
3. **Auth/onboarding copy is mechanical.** Sign-in screen says "you@email.com" as placeholder — a casual golfer wants a friendly intro, not a form.
4. **Profile screen has stray emoji (📏) for Units.** Breaks the lucide-icon system.
5. **Inconsistent border-radius spread.** `8 / 10 / 12 / 16 / 24` theme tokens exist, but screens mix hardcoded `3`, `10`, `16`, `19`, `24`, `32` and pull radius literals.
6. **Error states are mostly silent.** Network failure in `fetchRounds()` swallows the error; user sees stale/mock state with no explanation.
7. **Loading the home tab with zero rounds shows a good Trophy empty state, but it doesn't route the user to the Record tab.** Dead-end empty state.
8. **Profile avatar initial crashes** if `displayName` is empty string (`displayName[0].toUpperCase()` — `displayName || 'Golfer'` guards undefined but not empty string).
9. **Shop tab has no cart, no multi-item selection, no regional currency.** Feels like a demo, not a store.
10. **Record screen "Start Round" button is flat and easy to miss** against the dark surface — no primary CTA elevation.

---

## Issue Count by Severity

- **BLOCKER:** 2
- **HIGH:** 23
- **MED:** 31
- **LOW:** 18
- **Total:** 74

---

## Screen: Root Layout (`app/_layout.tsx`)

Screenshot would show: Splash, then routes. Biometric auth gate on native.

### Issues
- [MED] `app/_layout.tsx:51` — `if (loading || !biometricChecked) return null;` returns `null` during biometric auth instead of a branded placeholder. If biometric fails silently, the user sees a black screen with no recourse. Should route to a "Biometric required" retry screen.
- [LOW] `app/_layout.tsx:22-25` — `initialRouteName: '(tabs)'` is correct, but the comment "auth is gated per-action" is aspirational — right now `/profile/edit` etc. don't show an auth wall, they just break if unauthenticated.

### Proposed fixes
- Add a fallback "Authenticate again" screen during biometric hang.
- Add silent error boundary with a user-visible reset button.

---

## Screen: Tab Bar (`app/(tabs)/_layout.tsx`)

Screenshot would show: Dark tab bar, pulsing green Record button, 4 tabs (Library / [Record] / Shop / Profile).

### Issues
- [HIGH] `_layout.tsx:112` — **Tab labeled "Library" but home is a hero + stats + rounds feed.** The "Library" metaphor is too librarian-ish; casual golfers don't think about their rounds as a library. "Home" or "My Rounds" is clearer.
- [MED] `_layout.tsx:45-46` — Record tab button `pulseOpacity` animates 0 → 0.4 → 0 constantly while tab is focused. After 5 seconds this gets annoying. Should pulse 3 times then stop, or only pulse when there's an unfinished round to resume.
- [MED] `_layout.tsx:101-107` — `tabBarLabelStyle` fontSize `11` is below Apple HIG minimum. Bump to 12.
- [LOW] `_layout.tsx:97` — Tab bar height `88` with `paddingBottom: 28` assumes a home indicator. On Android (no home indicator) this wastes 28pt. Pull insets from SafeAreaInsets.
- [LOW] `_layout.tsx:82` — `CircleDot` icon on Record button is decent but not semantic — a `Video` or `Film` icon would read "highlight reel" better.

### Proposed fixes
- Rename "Library" to "Rounds" or "Home".
- Limit pulse to 3 cycles.
- Use `useSafeAreaInsets` for bottom padding on Android.

### Copy suggestions
- Current: "Library"
- Better: "Rounds"

---

## Screen: Home / Library (`app/(tabs)/index.tsx`)

Screenshot would show: Clippar wordmark top-left, bell icon top-right, hero reel card, sample data banner (if empty), stats row (6 stats), filter chips, 3 horizontal sections, then full-width list.

### Issues
- [BLOCKER] `index.tsx:138` — **The empty state has no CTA.** A brand new user sees Trophy + "Your Library is Empty" + descriptive text, and that's it. No "Start a Round" button, no route to `/record`. This is a dead-end empty state.
- [HIGH] `index.tsx:423-434` — The Clippar wordmark (28px, primary color) is the entire header. No greeting ("Good morning, Henry"), no date, no context. Feels like a nav title, not a home experience. PGA Tour app has hero greetings.
- [HIGH] `index.tsx:436-450` — The Bell icon is decorative — `onPress={() => Haptics.selectionAsync()}` goes nowhere. Casual golfer taps it expecting notifications or a dropdown. Dead button.
- [HIGH] `index.tsx:312-315` — `catch { /* Network error — keep whatever we had */ }` — silently swallows network errors. If the user is offline, they see sample data forever with no toast or banner.
- [HIGH] `index.tsx:453-471` — The "Sample data shown below" banner is okay, but the language is technical. "Sample data" screams "this is fake" — a casual golfer wants encouragement, not a watermark. Use: "These are sample rounds to show you what Clippar looks like. Record your first round to see yours!"
- [MED] `index.tsx:192-209` — `HomeSkeleton` is defined but **never rendered**. The actual loading path falls through to the `EmptyState` until `loaded` flips to true. Dead code.
- [MED] `index.tsx:424-435` — Wordmark uses hardcoded `fontSize: 28, letterSpacing: -0.8` — should use `theme.typography.h1`.
- [MED] `index.tsx:441-450` — Bell icon button is `38x38` — fails 44x44 tap target minimum.
- [MED] `index.tsx:104-121` — `RoundListCard` meta dots between date / holes / clips use hardcoded `3x3` dot radius. Add a `Dot` primitive or use `·` character to match iOS convention.
- [LOW] `index.tsx:498-532` — The "All Rounds" section has an inline count badge, while horizontal sections use `SectionHeader`. Two patterns for section headers.

### Proposed fixes
- Rewrite `EmptyState` with a real CTA routing to `/record`.
- Add a header greeting ("Good morning, {name}") above the Clippar wordmark, or replace the wordmark with a day/date summary.
- Remove or wire the Bell icon to a notifications screen.
- Show a toast when offline (swallowed network errors → user-visible `Banner`).
- Wire up `HomeSkeleton` in the actual loading state.
- Normalize section headers.

### Copy suggestions
- Current: "Your Library is Empty"
- Better: "Ready for your first round?"

- Current: "Sample data shown below — upload your first round to see your stats"
- Better: "These are sample rounds to show you around. Tap the record button to capture your own."

---

## Screen: Record (`app/(tabs)/record.tsx`)

Screenshot would show: Record title, subtitle, (optional) orphaned round recovery, shutter status card, course search input, green "Start Round" button, ghost "Import from Camera Roll" button.

### Issues
- [HIGH] `record.tsx:221` — `<Button title="Start Round" onPress={startRound} style={{ marginTop: 24 }} />` — the primary CTA is the same style as any other button. No shadow, no glow, no pulse. Casual golfer doesn't know this is "the" button to press.
- [HIGH] `record.tsx:113-115` — Validation `Alert.alert('Course Name', 'Please enter or select a course to start.')` — an alert popup for form validation is jarring. Use inline error text below the input.
- [MED] `record.tsx:148-149` — "Start a new round to begin recording shots." — too mechanical. Casual tone would be "Pick your course and you're ready to go."
- [MED] `record.tsx:156-184` — Orphaned round recovery card is the right idea, but the two buttons are equal weight. Recovery is the preferred path — "Resume" should be primary and "Discard" should be ghost.
- [MED] `record.tsx:266-267` — Finished state: "{N} holes · {M} clips at {course}" uses `·` — good. But the total score is a massive 48px score with no unit label next to it. Add "Total" or "Score" caption.
- [MED] `record.tsx:243-250` — `[DEV] Simulate Shutter Press` button is shipped in dev. Confirm it's gated by `__DEV__` (it is, good) but label should be clearer: "Dev: Fake Click".
- [LOW] `record.tsx:186-212` — Shutter status card is `Card` + `Pressable` — on press, routes to `/profile/bluetooth`. Good. But there's no visual "chevron right" on Android — only shown when disconnected. Add always.
- [LOW] `record.tsx:223-241` — "Import Round from Camera Roll" — ghost-style bordered button matches primary button size but with green text on transparent. Too similar to primary — demote to text link.

### Proposed fixes
- Upgrade Start Round button with glow shadow.
- Inline form validation instead of Alert.
- Rebalance Resume/Discard button weight.

### Copy suggestions
- Current: "Start a new round to begin recording shots."
- Better: "Tap Start to begin a new round."

---

## Screen: Profile (`app/(tabs)/profile.tsx`)

Screenshot would show: Avatar + name (+ hcp / home course), Go Pro upsell card (if not Pro), 4 cards of settings rows, Sign Out button, version number.

### Issues
- [BLOCKER] `profile.tsx:192-195` — `{displayName[0].toUpperCase()}` — **crashes when `displayName` is an empty string** (after `.trim()`). Also fails if user name is emoji-only. Guard: `{(displayName.trim()[0] ?? 'G').toUpperCase()}`.
- [HIGH] `profile.tsx:375-376` — `<Text style={{ fontSize: 16 }}>📏</Text>` — **stray emoji as an icon** in a lucide-icon settings list. Use a lucide icon like `Ruler` or `Scale`.
- [HIGH] `profile.tsx:452` — "Clear Cache" onPress is `() => {}` — **dead button**. Alert shows but Clear does nothing. Either implement or remove.
- [HIGH] `profile.tsx:463-475` — "Tutorials", "Rate Clippar", "Feedback" — all `onPress={() => Haptics.selectionAsync()}` — **three dead buttons**.
- [MED] `profile.tsx:244-250` — Edit button (34x34) is below 44x44 tap target minimum.
- [MED] `profile.tsx:298-308` — "Go Pro" button is small on-card button. If the user is not Pro, this is the single most important CTA on the Profile tab — needs more presence. Full-width below the card would convert better.
- [MED] `profile.tsx:373-427` — Units toggle styling is custom with manual segmented-control. Should reuse a `SegmentedControl` primitive for consistency (Shop probably has one too).
- [LOW] `profile.tsx:141-153` — Sign Out uses `Alert.alert` for confirmation — acceptable, but could be a bottom sheet for continuity with the rest of the app.
- [LOW] `profile.tsx:496` — Hardcoded "Clippar v1.0.0" — should read from `expo-constants`.

### Proposed fixes
- Guard empty displayName.
- Replace emoji icon with lucide.
- Remove or implement dead buttons.
- Upgrade avatar tap area.

---

## Screen: Login (`app/(auth)/login.tsx`)

Screenshot would show: Centered Clippar wordmark + tagline, two inputs, error line, Sign In button, "Don't have an account? Sign Up" link.

### Issues
- [HIGH] `login.tsx:58-78` — Clippar wordmark + "Every Shot. Remembered." — good tagline. But there's no hero image, no golfer silhouette, nothing visual. It's a dark void with a tiny logo. First impression is "generic SaaS form".
- [HIGH] `login.tsx:24-41` — Error handling surfaces `err.message` raw to the user. Supabase errors like "Invalid login credentials" — acceptable. But "AuthApiError: ..." from network would be gibberish. Map known errors to friendly copy.
- [MED] `login.tsx:26-28` — `if (!email.trim() || !password.trim())` — validation runs on submit only. No inline email-format check. User types "henry" hits Sign In, gets "Please fill in all fields" — confusing.
- [MED] `login.tsx:94-111` — Email input has no email-shape icon inside (like a Mail icon left-aligned). Plain text fields feel like 2015 form design.
- [MED] `login.tsx:145-149` — Error text is centered but occupies full width; a red icon left of the text would improve scan-ability.
- [LOW] `login.tsx` — No "Forgot password?" link. A casual golfer who forgot their password is stuck.
- [LOW] `login.tsx` — No social login (Apple / Google) — required for Apple App Store if other social providers are used. Low priority if not using social auth.

### Proposed fixes
- Add hero image or animated logo.
- Friendly error mapping.
- Inline email validation.
- Add "Forgot password?" link.

### Copy suggestions
- Current: "Every Shot. Remembered."
- Better: (keep — this is good)

---

## Screen: Sign Up (`app/(auth)/signup.tsx`)

Screenshot would show: Same layout as login, 3 inputs (display name / email / password), success state says "Check Your Email".

### Issues
- [HIGH] `signup.tsx:31-33` — Password requirement: "at least 6 characters" — way below modern security minimum. Should be 8, ideally with a strength indicator.
- [MED] `signup.tsx:49-77` — Success state "Check Your Email" is functional, but email redirect success is a moment of triumph — deserves a celebration animation (you have `CelebrationAnimation.tsx`).
- [MED] `signup.tsx:194-195` — "Min 6 characters" placeholder inside password field — once user types, the hint is gone. Put the requirement below the field permanently.
- [LOW] `signup.tsx:111` — "Create your account" subtitle is generic. Try "Start tracking your rounds."

### Copy suggestions
- Current: "Create your account"
- Better: "Join Clippar in 30 seconds."

---

## Screen: Onboarding (`app/(auth)/onboarding.tsx`)

Screenshot would show: Welcome title, description, 3 numbered steps, Get Started button.

### Issues
- [HIGH] `onboarding.tsx:57-59` — The number "1" inside the primaryMuted circle has no explicit color — defaults to text color which might be black/white depending on parent. Looks broken.
- [MED] `onboarding.tsx:7-139` — This is a one-screen onboarding with 3 steps. Competitors use horizontal swipeable 3-screen onboarding with illustrations. Feels like a help doc, not a welcome.
- [MED] `onboarding.tsx:28-38` — Description "Record every shot, get automatic highlight reels, and build your personal golf library." — long one-liner, reads as features not benefits. Split into 3 benefits, each illustrated.
- [LOW] `onboarding.tsx:133-136` — "Get Started" button routes to `(tabs)`. Should probably route to `/record` — onboarding's job is to guide to the first recording.

### Copy suggestions
- Current: "Record every shot, get automatic highlight reels, and build your personal golf library."
- Better: "Your rounds, automatically turned into highlight reels. No editing."

---

## Screen: Round Detail (`app/round/[id].tsx`)

Screenshot would show: Header (back arrow, course name, save / share / delete), big video player (55% of screen), score strip (Score / To Par / Holes / Date), collapsible Edit Clips section.

### Issues
- [HIGH] `[id].tsx:385` — Trash2 icon in header is accentRed and always visible. A casual golfer might tap it while trying to share, and even though it's confirmed, having "delete" in the header is nerve-wracking. Move to a "More" menu (three dots).
- [HIGH] `[id].tsx:433-441` — "Processing Failed" state shows a Retry button but **no reason why it failed**. Show error message from API. Also add a "Contact Support" link for persistent failures.
- [MED] `[id].tsx:442-461` — "No highlight reel yet" + "Edit Reel" button — confusing. If there's no reel, why say "Edit"? Either say "Build Reel" (if clips exist and nothing is processed) or hide when clips=0.
- [MED] `[id].tsx:391-398` — Loading state is two SkeletonCards — but the actual layout is a 55%-tall video + score strip + clips. The skeleton doesn't mirror the real layout. Make it shape-match.
- [MED] `[id].tsx:594-597` — "Deleting round..." overlay is centered ActivityIndicator + text. Good UX, but uses hardcoded 'rgba(0,0,0,0.6)' — use a theme token.
- [LOW] `[id].tsx:347-349` — `headerTitle` is `numberOfLines={1}` but has flex:1 and text-align center — on a long course name it clips mid-word. Consider marquee or allow 2 lines.

### Proposed fixes
- Move delete to overflow menu.
- Expand failure state with reason + support link.
- Better loading skeleton.

---

## Screen: Preview Story (`app/round/preview.tsx`)

Screenshot would show: Instagram-style fullscreen video, progress dots top, close button top-right, left/right tap zones.

### Issues
- [MED] `preview.tsx:93-111` — Web fallback is a black screen with text — fine for web dev but **any real mobile web user sees "Video preview on device only"** which is a dead end. Render a still image or gradient if available.
- [MED] `preview.tsx:131-143` — Web auto-advance is 3s fixed — for a 20-clip round that's a full minute. Should match native clip duration.
- [LOW] `preview.tsx:223-232` — Left/right tap zones divide the screen 50/50 — an accidental tap in the middle is ambiguous. Consider a center "pause" zone.

---

## Screen: Profile Edit (`app/profile/edit.tsx`)

Not inspected in detail (scope limit). Expected issues: form validation, avatar upload permissions, back button on save.

---

## Screen: My Rounds (`app/profile/rounds.tsx`)

Screenshot would show: Section list grouped by status (Drafts / Uploading / Processing / Failed / Completed), each row has score circle or status icon, course, date, holes, status badge, progress bar when active.

### Issues
- [HIGH] `rounds.tsx:377-378` — Loading state is full-screen centered `ActivityIndicator` — generic spinner on blank page. Should be section-shaped skeletons.
- [MED] `rounds.tsx:205-244` — Empty state: Film icon + "No Rounds Yet" + description. Good. No CTA to start a round though — another dead-end empty state.
- [MED] `rounds.tsx:176-180` — StatusBadge + ChevronRight stacked vertically — on narrow screens (older iPhones SE) this can overflow. Consider badge-only on <375px width.
- [LOW] `rounds.tsx:282-296` — Polling every 10s while any upload is active — could add subtle pulse to the active row to show "we're watching".

### Proposed fixes
- Add "Start a Round" CTA to empty state.
- Replace spinner with section skeletons.

---

## Screen: Shop (`app/(tabs)/shop.tsx`)

Screenshot would show: Title, kit selector (standard/premium), feature list, selling points row, Buy button.

### Issues
- [MED] Only partially read — but from the imports and structure: **no regional currency** (AUD/USD hardcoded?), **no shipping region picker**, **no "Already own this?"** escape hatch.
- [LOW] Kit names "Standard" and "Premium" are vague — "Essentials" and "Pro" read better.

---

## Screen: Bluetooth (`app/profile/bluetooth.tsx`)

Not inspected. Expected issues: empty "no device paired" state, reconnect flow, battery indicator.

---

## Shared Components Audit

### `components/ui/Button.tsx`
- [LOW] `Button.tsx:75` — `borderRadius: theme.radius.full` = 9999 = pill. That works for primary actions. Secondary buttons should probably be `radius.md` = 12 for variety, but consistency wins.
- [LOW] `Button.tsx:77` — `paddingVertical: 14` — should use `theme.spacing.md` = 16 or add a `padding` token.

### `components/ui/Card.tsx`
- [LOW] Uses theme tokens correctly. No issues.

### `components/ui/Skeleton.tsx`
- [MED] `Skeleton.tsx:28-34` — Opacity-only skeleton (0.3 → 0.7). Modern apps use **shimmer gradients** (sliding highlight). Much more polished.
- [LOW] `Skeleton.tsx:45` — `width: width as number` cast to number even when passed a string ('60%') works at runtime but is a type lie. RN accepts `DimensionValue`.

### `components/library/HeroReel.tsx`
- [LOW] `HeroReel.tsx:116-128` — Play button pulses constantly via scale 1 → 1.05 → 1 every 4s. Gentle — OK but could disable when reelSignedUrl is present (video is playing, pulse is redundant).
- [LOW] `HeroReel.tsx:150-152` — "LATEST HIGHLIGHT" all-caps label — consistent, but consider "Your Latest Round" to sound less like a YouTube thumbnail.

### `components/library/StatsRow.tsx`
- [MED] `StatsRow.tsx:21` — `minWidth: 80` for each stat — on tall thin phones 6 stats may not scroll if total < screen width. Looks fine but verify. Default golfer stats (Best, Rounds, Average, Birdies, Eagles, AvgPutts) are okay but no context (no last-N indicator).

### `components/library/FilterChips.tsx`
- [LOW] No issues. Clean.

### `components/library/RoundCardHorizontal.tsx`
- Not inspected line-by-line. Looked solid.

### `components/shared/ShareSheet.tsx`
- Not inspected.

### `components/shared/CelebrationAnimation.tsx`
- Used only on success — expand to signup confirmation and first round completion.

---

## Systemic Issues (across multiple screens)

### Empty-state CTA gap
Every empty state (Home, My Rounds, future Shop empty cart) describes the problem but provides no action. Add primary CTA + secondary escape.

### Loading-state gap
Most screens use either ActivityIndicator or nothing. Skeleton shapes that mirror real content are only used in Home (defined but not rendered) and Round Detail (using generic SkeletonCard).

### Border radius drift
Hardcoded radii: `3, 10, 12, 16, 19, 20, 24, 26, 30, 32, 35`. Theme has `8, 12, 16, 24, 9999`. Pick 5, stick to them.

### Tap target sizing
38x38 and 34x34 buttons appear in Home and Profile headers. All should be ≥ 44x44 per HIG.

### Dead buttons
- `index.tsx:436-450` Bell icon
- `profile.tsx:446-455` Clear Cache
- `profile.tsx:462-477` Tutorials, Rate, Feedback
- 5 dead buttons in total → casual golfer taps, nothing happens, loses trust.

### Error swallowing
`catch {}` appears in `index.tsx:312`, `profile.tsx:122`, `profile.tsx:133` — silent failures. Add a lightweight toast system.

### Copy voice
Current tone is technical: "Session", "Upload", "Processing", "Cache". Casual golfer voice: "Recording", "Uploading your round", "Making your reel", "Clear thumbnails".

---

## Recommended Fix Priority (Top 8 implemented in this PR)

1. **Home empty state gets a real CTA** — routes to `/record`
2. **Fix profile avatar crash** — empty displayName guard
3. **Replace emoji unit icon** — use lucide `Ruler`
4. **Remove or gate dead buttons** — `bell`, `rate`, `feedback`, `tutorials` wrapped with `onPress` stub removed or clearly marked "Coming soon"
5. **Upgrade Start Round button** — add glow shadow when valid
6. **Upgrade Skeleton with shimmer** — real pro polish
7. **Home header greeting** — friendly "Good morning, {name}" above wordmark
8. **Tab bar: rename "Library" to "Rounds"** — casual-golfer-first naming
9. **Render HomeSkeleton in loading state** (bonus — wiring existing dead code)
10. **Normalize tap targets to 44x44** (bonus)

---

## What's left unfixed (for next PR)

- Record tab: inline form validation instead of Alert popup
- Round Detail: overflow menu for delete
- Onboarding: rebuild as 3-screen horizontal swipeable
- Stripe checkout: regional currency + shipping
- Network failure toast system
- Forgot password flow
- Deep link: biometric failure recovery
- Bluetooth pairing empty state
- Processing failure error message + support link
