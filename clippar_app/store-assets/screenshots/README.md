# App Store screenshots

Upload one of the sized folders to App Store Connect. Do NOT upload
`originals/` — App Store Connect rejects anything that is not an exact
supported iPhone resolution, and the originals are 852x1846 / 853x1844.

| folder | resolution | device class |
|---|---|---|
| `6.9-inch-1320x2868/` | 1320 x 2868 | iPhone 16 Pro Max and similar |
| `6.7-inch-1290x2796/` | 1290 x 2796 | iPhone 15/16 Plus and similar |
| `originals/` | as supplied | source only, never upload |

Order is encoded in the filename prefix (01, 02, 03) and is the order they
should appear on the product page: record, trim, share.

## Quality note

The sized sets were produced by scaling the originals up ~1.5x, so they are
slightly softer than a native capture. The source aspect ratio (0.4615) is
within 0.3% of both targets, so nothing is visibly stretched.

If these are ever regenerated, capture at native device resolution instead
(screenshot on the phone -> AirDrop) and no upscale is needed.
