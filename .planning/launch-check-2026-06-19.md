# Clippar v1 Launch Readiness Check — 2026-06-19

> 30-day check-in since Wave 2 (auth foundation, PR #38).  
> This is analysis only — no config changed, nothing merged.

---

## Shipped Since Wave 2 (PRs #39 → latest)

| # | What shipped |
|---|---|
| #39 | Wave 3 Phase A — `course_presets` schema, types, and API |
| #40 | Wave 3 Phase B — mode chooser on Record tab |
| #41 | BLE 1/2/3-click shutter-button mapping |
| #42 | Torch on while recording |
| #43 | Wave 3 Phase C — preset picker, 9/18 hole count, start hole selection |
| #44 | Reel export kept alive when app goes to background |
| #45 | iCloud download failure caught from picker (CLIPPAR-9) |
| #46 | Strip auto-detect mode from import |
| #48 | Auth fix: resolve user from session (fixes false "Not authenticated" on start) |
| #49 | Auth fix: root auth gate + clearer error message |
| #50 | Wave 3 Phase D — preset picker landing + confirm sheet |
| #51 | Recording-screen batch: tutorial, options, review, delete, move |
| HEAD | fix: stray brace in moveClipToHole (broke Metro bundle) |

Wave 3 (recording flow overhaul) is now **complete and merged**. Auth flow is solid.

---

## Issue #22 — Outstanding Items

Items that have shipped are struck through. Remaining:

- [x] Nav bar symmetry → done (#23)
- [x] Email flow / password reset → done (#38)
- [x] Google + Apple sign-in → done (#38)
- [x] Recording flow + presets + course/hole config → done (Wave 3, #39–#51)
- [x] BLE mapping → done (#41)
- [x] Import progress count → done (#23)
- [ ] **Shop / premium page** — UI/UX design not started
- [ ] **Onboarding flow for non-buyers** — replay button exists but no monetization hook or paywall flow
- [ ] **BLE setup instructions at round start** (first-time UX, "don't show again") — mapping ships but the guided setup at round start is not implemented
- [ ] **Drag-and-drop clip reorder in import** — hold → pop-up → drag with + indicators between positions
- [ ] **Drag-and-drop clip reorder in editor** — same UX as import
- [ ] **Golf API for par / distance data** — no integration shipped
- [ ] **Per-user trim length config** — no settings screen for trim seconds
- [ ] **Export speed optimisation** — backgrounding fix shipped (#44) but raw speed not improved
- [ ] **Premium / tier model** — no tiering defined or implemented
- [ ] Export settings copy: "no cloud needed" — likely fixed in #23 but unconfirmed

**Score: 8/16 items shipped from issue #22.**

---

## Production Blockers

### 🔴 BLOCKER 1 — Volume lost on export (issues #53, #54)
Two separate filed issues (June 7): all clips export with no audio. Branch  
`origin/claude/issue-54-20260607-0716` was created but **never merged to main**.  
This is an active regression visible to any user who exports a round.  
**Action: merge or close the fix branch immediately.**

### 🔴 BLOCKER 2 — Google OAuth consent screen in Testing mode
Only listed test users can sign in via Google. Publishing requires:
- Privacy policy URL live on **clippargolf.com**
- Terms of service URL live on **clippargolf.com**
- Domain verification of clippargolf.com in Google Search Console
- Then: console.cloud.google.com → OAuth consent screen → Publish

Cannot be checked by code — **Henry must verify manually at:**  
`https://console.cloud.google.com/auth/audience?project=clippar-491303`

### 🟡 BLOCKER 3 — Custom SMTP not configured
No code evidence of Resend or any custom SMTP being set up. Supabase default  
(`noreply@mail.app.supabase.io`) is the sender for password reset emails and  
magic links. This will look unpolished and may hit rate limits.  
**Action needed in both Supabase projects:**
1. Add Resend account, verify clippargolf.com (SPF + DKIM records)
2. Authentication → SMTP Settings → enter Resend credentials
3. Sender address: e.g. `hello@clippargolf.com`

### 🟡 PR #52 — Multi-hole highlight reel (open, not merged)
`feat(editor): select multiple holes → custom highlight reel` is ready and reviewed  
but sitting open. Not a hard launch blocker but represents finished work not in prod.

### ⚪ Two Codex branches (unknown state)
- `codex/full-inputs-anchor-putt-fixes`
- `codex/restore-trim-putt-checkpoint`  
Unknown purpose, never merged. Needs triage — merge or close.

---

## Recommended Next Actions

**Immediate (this week):**
1. **Fix the volume bug** — investigate `origin/claude/issue-54-20260607-0716`, test it,  
   merge to main. Active regression, highest priority.
2. **Merge PR #52** — it's done; get it in.
3. **Triage Codex branches** — merge or close; don't let them rot.

**Henry only (can't be done in code):**
4. **Google OAuth** — check Testing vs Published status at the link above.  
   If still Testing: create minimal privacy policy + ToS pages on clippargolf.com,  
   verify domain, then publish.
5. **Resend SMTP** — configure in both Supabase dashboards.

**Next sprint:**
6. **Premium / tier model** — this is the biggest product gap before a real launch.  
   Decide free vs paid features, then build shop/paywall UI.
7. **Onboarding for non-buyers** — tie into the tier model once defined.
8. **BLE first-run setup guide** — short modal at round start, "don't show again" pref.

---

## Summary Verdict

Wave 3 is solid and merged. The recording + preset flow is complete. Auth works.  
**The app is not launch-ready today** due to:  
- An active audio regression (#54)  
- OAuth still gated to test users  
- No SMTP branding  
- No monetisation layer  

Fixing the audio bug + getting OAuth published is a ~1-week sprint. Monetisation  
is a larger sprint and the real gate before a public launch.
