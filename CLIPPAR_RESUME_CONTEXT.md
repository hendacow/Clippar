# Clippar — Resume Context

## Overview

**Clippar** is a cross-platform iOS/Android mobile application that automatically turns a round of golf into a shareable highlight reel. Casual golfers attach their phone to a tripod, clip a cheap Bluetooth remote to their belt, and click it once per shot. The app records each swing, detects the moment of impact on-device, trims the clip, tracks the scorecard hole-by-hole, and stitches everything into a single edited video with an overlaid scorecard and music — all without the golfer ever touching the screen mid-round.

I am the **founder and sole engineer**, responsible for the entire product end to end: concept, UX, data modelling, native and JavaScript development, backend, payments, authentication, CI/CD, release engineering, and production operations.

## Role & Scope

As the only developer, I own every layer of a real, shipping mobile product rather than a single slice of one. That includes designing the database schema and security model, writing custom native iOS code, building the React Native UI, configuring authentication providers, standing up the backend, wiring payment infrastructure, and operating a multi-environment release pipeline that pushes updates to a production app. I make the product decisions and the engineering trade-offs, and I ship them.

## Technical Architecture

Clippar is built on **Expo (React Native, SDK 54, React Native 0.81.5, Hermes)** with **TypeScript in strict mode**, using **expo-router** for typed, file-based navigation. The backend is **Supabase**: a Postgres database with **row-level security (RLS)** policies enforcing per-user data isolation, Supabase Auth, Edge Functions, and object storage for video assets. **Stripe** powers subscription billing and premium gating. **Sentry** provides production error tracking and crash reporting.

A defining technical characteristic of the app is that it is **offline-first**. Golf courses frequently have poor connectivity, so every round, score, and clip is written immediately to a local **SQLite** database (expo-sqlite) and synced to Supabase through a resilient background upload queue. The app gracefully recovers "orphaned" rounds interrupted by a crash or a closed app, and reconciles local and remote state on reconnect.

## Native iOS Development & On-Device Computer Vision

The most technically demanding component is a **custom Swift native module** I wrote and bridged into React Native through the Expo Modules API. It performs three jobs entirely on-device:

1. **Swing detection** using Apple's **Vision** framework to analyse video frames and locate the impact moment, distinguishing swings from putts.
2. **Automatic trimming** of raw footage down to a tight clip around impact, with configurable pre-roll and post-roll.
3. **Highlight-reel composition** using **AVFoundation** — concatenating clips, compositing a Core Animation scorecard overlay, mixing a music track, and exporting an H.264 MP4.

Doing this on-device (rather than in the cloud) avoids per-user server cost and keeps the experience fast and private. It also surfaced hard, low-level problems I had to debug and solve: iOS audio-session format negotiation failures that killed the capture session, HEVC/Dolby-Vision source incompatibilities with custom video compositions, and `AVErrorOperationInterrupted` failures when the OS suspended an export. I fixed the export issue by wrapping the compose pipeline in a UIKit background task, granting the work a grace window after the app backgrounds.

## Bluetooth Hardware Integration

Clippar's signature interaction is hands-free control via an off-the-shelf **Bluetooth shutter remote**. This required deep work on iOS input handling, because cheap remotes only emit a single HID key event per press and iOS routes Bluetooth differently depending on the device class. I built a unified input layer that fuses three signals — HID key events, system volume changes, and BLE GATT — and implemented **multi-click gesture recognition**: one click starts/stops recording, two clicks advance the hole, three clicks log a penalty stroke. Getting this reliable meant solving real signal-processing problems: cross-source de-duplication (the same press arrives via multiple channels), value-based suppression to stop the app's own volume resets from registering as phantom presses, and a tunable click-debounce window. I also researched the hardware market directly, characterising which remotes expose true HID keyboard codes versus those that only emulate an AssistiveTouch mouse cursor (invisible to the app).

## Authentication & Communications

I implemented a complete authentication system supporting **email/password, Google OAuth, and Sign in with Apple**. Apple Sign-In required generating a client-secret **JWT signed with a `.p8` key**, registering a Services ID, and configuring the entitlement and provisioning profile. I built a password-reset flow that, after diagnosing that email clients were pre-fetching and consuming one-time reset links, I redesigned around **OTP codes** instead. Transactional email is delivered through **Resend SMTP**.

## Release Engineering & Operations

Clippar runs across three build variants — development, staging, and production — each with its own bundle identifier, URL scheme, and **separate Supabase project**, so I can test against real infrastructure without touching production data. I build native binaries with **EAS Build** and ship JavaScript-layer changes to live users in seconds via **EAS Update (OTA)** over release channels, reserving full native rebuilds for changes that touch native code.

My day-to-day workflow is disciplined: feature branches, **stacked pull requests**, squash merges, and an automated CI pipeline running an AI code-review pass and a security scan on every PR, plus Vercel for the marketing/web surface. I run database migrations against both environments, manage API keys and signing credentials, and monitor production through Sentry. I caught and fixed a bundler-breaking issue introduced by a linter before it ever reached users, because the OTA export step acts as a final gate.

## Product & UX

Beyond engineering, I make and validate product decisions: a guided, interactive onboarding that has new users practise the clicker on a live (but discarded) dry-run before their first real round; a course-preset system for one-tap repeat setups; an in-round editor for reviewing footage and reassigning misattributed clips between holes; and continuous iteration based on my own field testing of the recording flow.

## Skills & Technologies Demonstrated

- **Languages:** TypeScript, Swift, SQL
- **Mobile:** React Native, Expo (SDK 54), expo-router, expo-camera, Expo Modules API, Hermes, EAS Build, EAS Update (OTA)
- **Native iOS:** AVFoundation, Vision (computer vision), Core Animation, UIKit background tasks, Bluetooth/HID input, code signing & provisioning
- **Backend:** Supabase (Postgres, Row-Level Security, Auth, Edge Functions, Storage), offline-first sync, SQLite, background job/upload queues
- **Auth & Payments:** OAuth (Google), Sign in with Apple (.p8 JWT), OTP flows, Stripe subscriptions
- **DevOps:** GitHub Actions CI, automated code review & security scanning, multi-environment release management, Sentry, Vercel
- **Practices:** end-to-end product ownership, system design, debugging low-level native/platform issues, hardware integration, iterative field-tested UX
