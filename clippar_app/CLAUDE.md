# Clippar — project guide for Claude Code

iOS golf highlight-reel app. Expo SDK 54 / RN 0.81 / TypeScript strict / expo-router /
Hermes / Supabase / Stripe / RevenueCat / a custom Swift module (`shot-detector`).
Audience: casual Australian golfers.

## Definition of done (run before claiming a task complete)

```
npm run verify      # typecheck + tests — CI runs this on every PR into main
```

A change is NOT done until: `verify` is green, AND it's been verified at the right
tier (below), AND — if it touches behaviour a user sees — confirmed working, not
just compiling.

Tests live in `tests/*.test.ts` (node:test + tsx, run with `npm test`) — for
pure logic (GPS, scoring, trim, geometry). Add one when you touch that kind of
code. Component/hook tests aren't scaffolded yet; verify UI via Expo Web instead.

## How to verify work — tiered, cheapest first

> **In a fresh worktree, run `npm install` in `clippar_app/` first and make
> sure `.env.local` exists** (symlink it from the main checkout). `git
> worktree add` copies tracked files only, so a new worktree has neither, and
> Metro cannot run without them. `scripts/cc-feature.sh` now does both
> automatically; worktrees created any other way (including the Claude Code
> harness's own under `.claude/worktrees/`) need it done by hand.
>
> Skipping it does NOT look like a setup problem — with no local
> node_modules, Node finds the MAIN checkout's, whose `file:` symlink for
> `shot-detector` points outside this worktree's Metro root. You get "Unable
> to resolve module shot-detector" (which reads as an app bug), or a bundle
> URL of `/../../../../node_modules/...` that escapes the dev-server root and
> renders a blank page with an empty console. Missing env gives
> "supabaseUrl is required". Install first and none of these appear.

1. **I verify alone (seconds):** `npm run verify`; for UI, run Expo Web
   (`npm run web`) and drive it with the browser preview tools; for logic
   (GPS, scoring, trim, geometry) write a headless sim like
   `scripts/simulate-tracer.ts` and run with `npx tsx`.
2. **I verify via logs (minutes):** start Metro piped to a file I can read
   (`npm run metro:log` → `/tmp/metro-clippar.log`), then read that file. Native
   device logs: `idevicesyslog --quiet | grep -i <term>`.
3. **Only the user can verify (device):** real camera capture, Bluetooth clicker,
   audio session, LiDAR, haptics, IAP purchase. These need a dev build on a
   physical iPhone — the user device-tests and pastes logs.

## The loop for every feature (MANDATORY)

plan → pre-mortem → build → SEE it render → review → signal done

1. **Plan + pre-mortem.** Write a short plan, then spawn a subagent to pre-mortem
   it: "given this plan and these files, what could go wrong?" — regressions, edge
   cases, security (RLS / secret keys), native/device pitfalls, anything a user
   would see break. Fold its answers back into the plan before you code.
2. **Build** to the plan.
3. **See it actually render — `npm run verify` is NOT proof it works.** Run the
   app in Expo Web (`npm run web:dev`) and confirm the change with your eyes on
   the running site: use the preview tools (preview_start / preview_snapshot /
   preview_click / preview_screenshot) — or Claude in Chrome on the localhost
   URL — to open it, exercise the feature, and screenshot the proof. UI that is
   native-only and can't render on web → defer that check to the user's device.
4. **Reviewer subagent before finishing.** Spawn a fresh subagent to review your
   diff against the pre-mortem list: is every "what could go wrong" item actually
   handled? Did anything regress? Fix what it finds, then re-verify.
5. **Signal done:** run `npm run done` as your final step (only when 1–4 are
   genuinely complete). It runs the verify gate, sends Henry a desktop/push
   notification with pass/fail + summary, and drops a result file the command
   session reads to deliver him the full review.

## Hard-won gotchas (do not relearn these)

- **Never debug camera / audio / tracer *renders* on the iOS simulator.** The
  simulator's camera has no real lenses (`getAvailableLensesAsync` → `[]`),
  records no real audio, and `AVVideoCompositionCoreAnimationTool` exports crash
  in Apple's IOSurface emulation. These are device-only.
- **`-10868` audio recording failure** = the audio session is wrong at mic-attach.
  Root cause was `react-native-volume-manager` forcing `.ambient`; patched in
  `patches/react-native-volume-manager+2.0.8.patch`. Native patch → needs a
  rebuild, not a Metro reload.
- **Reanimated worklets:** JS side-effects from animated values go through
  `useAnimatedReaction`, never `runOnJS` + shared-value writes inside
  `useAnimatedProps` (trips the reentrancy guard → hard crash). Plain JS helpers
  called from a worklet need the `'worklet'` directive.
- **Feature flags live in `constants/config.ts`.** Ship risky work to main OFF by
  default (e.g. `config.tracer.enabled`), flip it on when validated. Day-zero
  paths must stay byte-identical when a flag is off.
- **Metro:** always `APP_VARIANT=development` so the bundle matches the dev client.

## Known security landmines (see foundations audit)

- **Storage RLS is NOT owner-scoped.** The `clips` bucket policies are
  `bucket_id = 'clips'` for all authenticated users → any signed-in user can
  list/read/overwrite/delete ANY user's clips. Fix: scope to `owner = auth.uid()`
  (or a `<user_id>/` path prefix). Table RLS (rounds/scores/shots/etc.) IS
  correctly scoped to `auth.uid()`.
- **Secret keys ship in the client:** `EXPO_PUBLIC_PIPELINE_API_KEY`,
  `EXPO_PUBLIC_GOLF_COURSE_API_KEY` are embedded in the bundle. Move behind an
  Edge Function proxy. (The Supabase anon key is meant to be public.)
- **No soft-delete** (`deleted_at`) anywhere — deletes are unrecoverable.

## Workflow conventions

- **One feature = one branch off `main` = one worktree = one Claude session = one
  Metro** (own port). Spin up with `scripts/cc-feature.sh <name>`.
- **Tooling/infra changes** (this file, scripts, CI) go to `main` so every
  worktree inherits them.
- **Commit messages** end with the Co-Authored-By trailer. Commit/push only when
  asked. Never commit straight to `main` — branch, PR, let CI gate it.
- **Merge ritual:** `verify` green → device-confirm if Tier 3 → rebase on `main`
  → PR → CI green → merge → `git worktree remove`.
