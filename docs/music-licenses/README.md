# Music licenses — bundled track provenance

All bundled music tracks in `clippar_app/assets/music/` (other than the three
legacy `Clippar` tracks) are sourced from **Pixabay** under the
**Pixabay Content License** — free for commercial use, covers redistribution
inside an app and inside user-exported videos, **no attribution required**.
License summary: <https://pixabay.com/service/license-summary/>

- **Download date (all tracks): 2026-07-23**
- Processing: trimmed to 60–90 s edits, two-pass ffmpeg `loudnorm` to
  −14 LUFS integrated / ≤ −1 dBTP true peak, 44.1 kHz stereo, AAC 256 kbps `.m4a`.
- Per-track page snapshots (visible page text incl. the license statement) are
  saved in [`pages/`](pages/). Pixabay serves pages behind a Cloudflare
  challenge, so raw HTML mirrors were not possible; text extractions were
  captured via a real browser session on the download date.
- Archive.org snapshots were triggered via `https://web.archive.org/save/<url>`
  on 2026-07-23; results per track below.

## Tracks

### Hype

| File | Title | Artist | Pixabay page | License | Archive.org snapshot |
|---|---|---|---|---|---|
| `hype_1.m4a` | Motivation Epic Rock | AlexGrohl | <https://pixabay.com/music/rock-stomping-rock-four-shots-111444/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20250902131552/https://pixabay.com/music/rock-stomping-rock-four-shots-111444/> |
| `hype_2.m4a` | Epic Sport Rock Trailer | BFCMUSIC | <https://pixabay.com/music/rock-epic-sport-rock-trailer-247108/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20260723/https://pixabay.com/music/rock-epic-sport-rock-trailer-247108/> (SPN save confirmed 2026-07-23, HTTP 302; date-redirect link) |
| `hype_3.m4a` | Bright Energetic Electronica | penguinmusic | <https://pixabay.com/music/future-bass-penguinmusic-bright-energetic-electronica-12635/> | Pixabay Content License (no attribution required) | Save attempted 2026-07-23 (3×, `https://web.archive.org/save/https://pixabay.com/music/future-bass-penguinmusic-bright-energetic-electronica-12635/`) — archive.org returned HTTP 520 each time; retry later |

### Cinematic

| File | Title | Artist | Pixabay page | License | Archive.org snapshot |
|---|---|---|---|---|---|
| `cinematic_1.m4a` | Epic Adventure Cinematic Music Trailer | LudoSoundX | <https://pixabay.com/music/main-title-epic-adventure-cinematic-music-trailer-228400/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20260722233140/https://pixabay.com/music/main-title-epic-adventure-cinematic-music-trailer-228400/> |
| `cinematic_2.m4a` | Epic Hollywood Trailer | Good_B_Music | <https://pixabay.com/music/main-title-epic-hollywood-trailer-9489/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20260202075446/https://pixabay.com/music/main-title-epic-hollywood-trailer-9489/> |
| `cinematic_3.m4a` | Inspiring Cinematic Trailer | Music_For_Videos | <https://pixabay.com/music/epic-classical-inspiring-cinematic-trailer-166426/> | Pixabay Content License (no attribution required) | Save attempted 2026-07-23 (3×, `https://web.archive.org/save/https://pixabay.com/music/epic-classical-inspiring-cinematic-trailer-166426/`) — archive.org returned HTTP 520 each time; retry later |

### Chill

| File | Title | Artist | Pixabay page | License | Archive.org snapshot |
|---|---|---|---|---|---|
| `chill_1.m4a` | Lofi Study — Calm Peaceful Chill Hop | FASSounds | <https://pixabay.com/music/beats-lofi-study-calm-peaceful-chill-hop-112191/> | Pixabay Content License (no attribution required) | Save attempted 2026-07-23 (3×, `https://web.archive.org/save/https://pixabay.com/music/beats-lofi-study-calm-peaceful-chill-hop-112191/`) — archive.org returned HTTP 520 each time; retry later |
| `chill_2.m4a` | Modern Chillout (Future Calm) | penguinmusic | <https://pixabay.com/music/upbeat-penguinmusic-modern-chillout-future-calm-12641/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20250815221556/https://pixabay.com/music/upbeat-penguinmusic-modern-chillout-future-calm-12641/> |
| `chill_3.m4a` | Just Relax | Lesfm (music_for_video) | <https://pixabay.com/music/beautiful-plays-just-relax-11157/> | Pixabay Content License (no attribution required) | <https://web.archive.org/web/20260722233207/https://pixabay.com/music/beautiful-plays-just-relax-11157/> |

## Substitution note

The research memo's original Cinematic candidate
`https://pixabay.com/music/main-title-epic-inspirational-cinematic-trailer-204849/`
("Epic inspirational Cinematic Trailer" by ArtIssizm) was **rejected during
acquisition**: the artist's Pixabay profile states *"My music on this site is
not for commercial use … contact me … to purchase a license for commercial use
and avoid any issues with CID."* Regardless of the page-level license banner,
that is a live Content-ID / dispute risk for a commercial app, so it was
substituted with **Epic Hollywood Trailer** by Good_B_Music (same Pixabay
main-title/cinematic category, Editor's Choice, 4.8k downloads, no conflicting
artist terms).

## Legacy tracks

`chill_vibes.m4a`, `focus_mode.m4a`, `victory_lap.m4a` predate this library
(originally bundled as Clippar in-house/royalty-free assets) and are kept
unchanged so existing user reels that reference them continue to resolve.
