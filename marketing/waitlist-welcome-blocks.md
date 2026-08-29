# Waitlist welcome email — paste-ready blocks

Same content as `waitlist-welcome-email.html`, broken into the blocks Shopify
Messaging's editor uses, so it can be assembled without retyping anything.

**Set as draft. Do not send** until the copy has been read through once.

---

## Campaign settings

| Field | Value |
|---|---|
| **Subject** | You're on the Clippar waitlist |
| **Preview text** | What you signed up for, and what happens next. |
| **From** | Clippar &lt;henry@clippargolf.com&gt; — already the sender, already authenticated |
| **To** | The `waitlist` customer segment (13 people) |

---

## Brand settings — set these once, they apply to every email

| Token | Hex |
|---|---|
| Background | `#07100a` |
| Card / panel | `#0d1a10` |
| Accent, buttons, small caps | `#a8e63d` |
| Heading text | `#f0f4ee` |
| Body text | `#c9d6c6` |
| Muted / footer | `#7a9178` |
| Divider | `#1c2f1e` |

Logo: `clippar-logo-green.png`, 132px wide.
Button label colour on green: `#07100a` — dark on light, not white.

---

## Block 1 — Image (logo)

`https://clippargolf.com/cdn/shop/t/2/assets/clippar-logo-green.png`
Width 132px, centred.

## Block 2 — Text (eyebrow + headline)

> WAITLIST CONFIRMED

> # You're on the list.

Eyebrow in the accent green, mono, uppercase, letter-spaced. Headline large and tight.

## Block 3 — Text

> Thanks for signing up. Here's what Clippar actually does, what it needs from you, and when you'll hear from us next. One minute to read, then nothing to do until we're ready for testers.

## Block 4 — Text (What it is)

> **WHAT IT IS**
>
> Clippar turns a whole round of footage into a highlight reel of only your shots. You film the round. The AI finds each swing, trims it to the moment that matters, and assembles the lot. You walk off with about **five minutes worth watching** instead of two hours of grass.

## Block 5 — Two-column image row

| Left | Right |
|---|---|
| `.../assets/step1_poster.jpg` | `.../assets/hero_annotated.jpg` |
| Caption: CLIPS TO YOUR BUGGY | Caption: WHAT THE AI SEES |

Full paths are `https://clippargolf.com/cdn/shop/t/2/assets/<filename>`.
Both are portrait; at 252px wide they land at the same height, so the row stays even.

## Block 6 — Text (the three steps)

> **WHAT IT TAKES FROM YOU**
>
> **01 Click.** The mount clips onto your buggy or bag. Phone in the holder, angled how you like it.
>
> **02 Swing.** Press the Bluetooth clicker on your belt as you walk to the ball. Then just play your shot.
>
> **03 Clip.** The AI trims each shot using your pose, the ball flight and the sound of impact. No editing from you.

Step numbers in accent green, mono.

## Block 7 — Text (the library)

> **AND IT KEEPS THEM**
>
> Every round goes into a library you can filter — best rounds, worst holes, your birdies, any date. Six months in, you can scroll back and see where your game actually was, rather than a number on a scorecard.

## Block 8 — Text (the goal)

> **WHERE THIS IS GOING**
>
> The goal is straightforward: **get Clippar live for everyone**. Not a closed circle, not a waitlist that never opens. The finished thing, on general release.
>
> Getting there means testing it on real rounds, on real courses, by people who actually play. That's where you come in.

## Block 9 — Panel (what happens next)

Panel background `#111f14`, border `#1c2f1e`.

> **WHAT HAPPENS NEXT**
>
> We'll email you beta instructions once we're ready for testers — what you'll need, what to expect, and what we'd like you to look out for. Nothing to do until then. Keep an eye on your inbox.

## Block 10 — Button

Label: **ASK US ANYTHING**
Link: `https://clippargolf.com/pages/contact`
Green fill, dark label.

The contact form is the only honest call to action right now — there is nothing
to buy, and sending waitlist members back to the waitlist page would be absurd.

## Block 11 — Text (sign-off)

> Thanks for being early.
> Henry

## Block 12 — Footer

> **Clippar Pty Ltd** · ACN 701 393 277 · ABN 69 701 393 277
>
> You're getting this because you joined the Clippar waitlist.
>
> Contact · Privacy · Unsubscribe

Shopify inserts the unsubscribe link itself. Contact →
`/pages/contact`, Privacy → `/pages/privacy-policy`.

---

## Accuracy note

Every capability described is taken from the live landing page — the clicker, the
pose/ball-flight/impact trimming, the filterable library. Nothing is invented, and
the email promises a general release rather than implying one already exists. If
any of it overstates where the build actually is, change the copy rather than
letting the email set an expectation the product has to meet.
