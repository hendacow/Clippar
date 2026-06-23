# Clippar UX Walkthrough Findings (iPhone 17 Pro sim, iOS 26.5, dev build)

## Bugs
1. **Onboarding tour fires on the LOGIN screen** — "Step 1 of 5: Tap here to start a round" coach-marks render over the email/password form, anchored to nothing (the record button doesn't exist pre-auth). All 5 steps run there. Should trigger on first Record-tab visit post-auth.
2. **Stat tiles clipped under tab bar on Home first paint** — yellow/green "0 0 0 0" digits peek from beneath the tab bar before scrolling; looks broken.
3. **Sample-data inconsistency on Home** — header stats say "7 rounds, +6.1 avg", round cards show birdie/eagle chips, but the Eagles/Birdies/Pars/Bogeys tiles all show 0. Sample data should be coherent.

## Observations / improvement ideas
- Onboarding (4 screens) is clean, good copy ("No editing. No fuss.").
- Login: clean; Apple/Google buttons good; "Every Shot. Remembered." tagline nice.
- Home: rich for a new user — filter chips (course/hole/7-90d/1yr) shown before any real data exists; consider hiding filters until ≥2 rounds.
- "Hold a tile to play a highlight reel" hint is tiny gray text — discoverability of a fun feature is low.
- Home sections: Latest Highlight, stat tiles, Score Trend, Recent Rounds, Best Rounds, Birdies & Eagles, All Rounds — possibly redundant (Recent/Best/B&E all show the same sample rounds 3 ways).
4. **Sample rounds navigate to "Round not found"** — every Home card/row for the demo data opens an empty round-detail screen with share + delete icons and "Round not found" text. New users' first taps all dead-end. Fix: make sample cards non-navigable, or ship a real demo round, or show a "This is sample data — record your first round" CTA sheet instead.
5. **"Go Pro" button is a no-op** — app/(tabs)/profile.tsx: onPress only fires a haptic. No paywall, no checkout, no link. The app currently has NO way to subscribe. (Pairs with the App Store finding: the fix is a StoreKit IAP paywall screen, not a Stripe link — links to web checkout for digital subs are rejected in AU.)
6. **No "Delete account" anywhere** — Apple 5.1.1(v) hard requirement; rejection guaranteed.
7. **No Privacy Policy / Terms links in-app** — required (5.1.1) and expected in Profile.
8. **Debug rows visible** — "Trim Sandbox (debug)", "Tracer Sim (debug)" in Profile; must be __DEV__-gated before submission.
9. **"Rate Clippar — Coming soon"** — wire StoreKit requestReview before launch or hide the row.
- Profile is otherwise well-organized: Pro card, rounds, clicker, trim, storage, units toggle, notifications, orders, cache, tour replay, diagnostics, feedback, verify rounds, sign out.

## Verified working (sim, end-to-end)
- Sign-in (email/password vs dev Supabase), session persistence, Save Password sheet
- Import Round flow: course search (live API, good results), hole-count chips, Quick/Manual import choice, scorecard entry (auto-advance, birdie/bogey colors, running total), photo picker, count-mismatch warning (3/12) handled gracefully, Review Clips per-hole assignment, import → editor, auto-trim batch (3/3 trimmed to 4s), Preview playback with scorecard overlay + pose/mute/trim controls, Export sheet
- Shop: kits, pricing, Stripe physical-goods checkout CTA (compliant)
- Profile: all rows navigate

## More findings
10. **Permissions burst on Record-chooser open** — mic and camera prompts fire back-to-back when opening the mode chooser, before the user picks Live or Import. Move each request to the moment of first actual use (Live start). Import-only users should never see camera/mic prompts.
11. **Photos double-prompt** — limited picker runs, then a full-library access prompt immediately follows ("saves reels to your library"). Consider PHPhotoLibrary add-only permission for saving exports instead of full access.
12. **Quick Import put all 3 clips on Hole 1** — with fewer videos than strokes, auto-assign dumps everything on hole 1 instead of distributing 1/1/1 across holes 1-3 in order. Confusing default.
13. **No Pro gating at export** — config has maxJobsPerDay etc., but no limit/paywall messaging anywhere in the export flow. If reels are the Pro feature, the paywall belongs here (and that's the natural IAP touchpoint).
14. **Editor title truncates** ("Victoria...") — course names almost always truncate at this width; consider subtitle wrap or smaller title.
