# Clippar — project guide for Claude Code

iOS golf highlight-reel app. Expo SDK 54 / RN 0.81 / TypeScript strict / expo-router /
Hermes / Supabase / Stripe / RevenueCat / a custom Swift module (`shot-detector`).
Audience: casual Australian golfers.

## Definition of done (run before claiming a task complete)

```
npm run verify      # typecheck (grows to include lint + tests)
```

A change is NOT done until: `verify` is green, AND it's been verified at the right
tier (below), AND — if it touches behaviour a user sees — confirmed working, not
just compiling.

## How to verify work — tiered, cheapest first

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
