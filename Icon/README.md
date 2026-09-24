# T3CodeBox icon

A line-drawn container whose edges spell **T**, **3** and **C** (T3Code), and whose shape is the **Box**.

## Folders

- `final/` — the icon to use
  - `adaptive/` — one file per size with all three color sets; switches with light/dark mode via an embedded style, which some renderers strip.
  - `light/`, `dark/`, `default/` — each color set as its own file, for places that strip SVG styles (use with `<picture><source media="(prefers-color-scheme: dark)">`).
  - `mono/` — single color, uses `currentColor`.
- `history/` — the full design history (`Design History.dc.html`, newest turn at the top) and every SVG exported along the way in `history/icons/`.

## Sizes

- **16px** — hand-placed pixels, every pixel fully on or off, 2px gaps (1px on the short face).
- **24px** — 2px stroke on a 24 grid, pixel-snapped.
- **48px** — 3px stroke on a 48 grid, pixel-snapped.

## Construction (final, Turn 20 "Equal T arms")

View: corner C nearest, both bottom edges (GE, EF) angled away, 2:1 pixel slopes.

- **T** (red/orange) — bar A–C–P, stem C–E. Left arm AC and right arm CP are equal on screen.
- **3** (green) — R–B–D–F–S with middle arm D–Q. Its arms are the top (R–B), middle (Q–D) and bottom (F–S).
- **C** (blue) — H–V–G–U–M, wrapping the short face.
- Every letter is separated from the next by a gap.

Points: A/E = T ends, V/U = the corners the C wraps, B/D/F = 3 corners, G = bottom-left corner, H/M = C ends, R/S = 3 arm ends, P/Q = ends of the T bar and 3 middle arm on CD.

## Colors

| Letter | Light mode (on white) | Dark mode (on #0D1117) | Default (both) |
|---|---|---|---|
| T | `#C03B01` · 5.43:1 | `#E75D2F` · 5.41:1 | `#D44B1A` · 4.36 / 4.34 |
| 3 | `#057B32` · 5.40:1 | `#129E44` · 5.41:1 | `#008D39` · 4.31 / 4.39 |
| C | `#2365D1` · 5.45:1 | `#4487F6` · 5.45:1 | `#3376E3` · 4.34 / 4.36 |

Hues come from Claude orange (strengthened to `#E2582A`), Google green `#34A853` and Google blue `#4285F4`; only lightness differs between sets.

## Evolution (see history for visuals)

1. Box drawn and edges/points named.
2. Perspective set: near corner C, bottom edges receding.
3. T = ACD + CE, 3 = BDF + arms; gaps added; T arms shortened to the K–H / L–M guides, then extended to the midpoints.
4. Construction A (C = K–G–L) → Construction B (C = H–V–G–U–M).
5. Pixel snapping; dedicated 16 / 24 / 48 drawings; wider gaps.
6. Decoration explored (ribs, prompt, lid seam, dots); final kept naked.
7. Container proportions: narrower, cube, then narrower with equal T arms (final).
8. RGB colors: Vivid, Balanced, Warm, Google, Google + Claude orange, then light/dark/default adaptive sets.
