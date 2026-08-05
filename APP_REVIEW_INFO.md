# App Review Information — paste into App Store Connect

Everything below goes on the version page under **App Review Information**.

---

## Sign-In Required

☑️ **Yes** (tick the box)

| Field | Value |
|---|---|
| User name | `appreview@clippargolf.com` |
| Password | `ClipparReview!2026` |

Created and verified in production Supabase on 2026-08-05. Signs in through the
app's normal email/password path. Account is on the **free** tier deliberately —
every feature is reachable without a subscription, so the reviewer needs no
special entitlement.

---

## Contact Information

| Field | Value |
|---|---|
| First name | Henry |
| Last name | Coward |
| Phone number | *(your mobile, with +61)* |
| Email | henrycoward@icloud.com |

---

## Notes (paste this whole block)

```
Clippar records a round of golf, automatically finds the swing in each
recording, trims to just the shot, and stitches the round into a highlight
reel.

HOW TO TEST WITHOUT A GOLF COURSE

The app does not require GPS or a real course to demonstrate its core
function. Either path works indoors:

1. RECORD (fastest)
   On the Home tab, tap "Record your first round" (or the Record tab).
   Pick any course from the list. Tap the shutter and capture a few
   seconds of any movement. The app runs its on-device swing detection and
   auto-trims the clip. Repeat once or twice, then tap Preview to see the
   round, and Export to produce the reel.

2. IMPORT FROM PHOTOS
   On the Home tab, tap "Already have clips? Import from Photos", then
   select any videos already in the photo library. The same auto-trim runs
   on imported footage.

The demo account already contains a completed round with real golf footage,
visible on the Rounds tab, if you would prefer to skip recording and go
straight to Preview / Export.

PERMISSIONS AND WHY

- Camera and Microphone: recording shots. Required.
- Photo Library: importing existing footage and saving exported reels.
- Location (When In Use): identifying which golf course you are at, to
  label the round. The app never requests Always. Declining location does
  not block any feature; you can pick a course manually.

SUBSCRIPTIONS

Clippar Pro is optional. Recording, auto-trimming, previewing and exporting
highlight reels are all free and unlimited. Pro adds convenience features
only. Nothing in the app is gated behind a purchase for this review.

ON-DEVICE PROCESSING

Swing detection and video trimming run entirely on device using Core ML and
Vision. No video is uploaded for analysis.
```

---

## Still to fill in (only you can do these)

- **Phone number** in Contact Information above.
- **Seed the demo round** — see the steps below. If you skip it, delete the
  sentence "The demo account already contains a completed round..." from the
  notes, because it must not claim something that isn't there.

---

## Seeding the demo round — 5 minutes on your phone

This is worth doing. It's the difference between a reviewer seeing an empty
app and having to improvise, and a reviewer opening it to a finished round of
real golf they can preview and export immediately.

Do it on your own device, through the real app — that guarantees the data is
correct and playable, which hand-inserting rows into the database does not.

1. Open Clippar. Profile > **Sign Out**.
2. Sign in as `appreview@clippargolf.com` / `ClipparReview!2026`.
3. **Import Round** > pick a course > select 6–9 of your existing golf clips
   from Photos > assign them to holes 1–3.
4. Let auto-trim finish (watch for "Trimmed" on every clip).
5. Enter scores for those holes so the scorecard shows colour-coded results.
6. Tap **Preview** and confirm the clips play and the scorecard looks right.
7. Profile > Sign Out, then sign back in as yourself.

Clips upload to Supabase storage and are served to the reviewer as signed
URLs, so they will play on Apple's device, not just yours.

⚠️ Do this **after** the Supabase billing upgrade goes through — if the
project is over quota the uploads will fail silently and you'll seed a round
with no video in it.
