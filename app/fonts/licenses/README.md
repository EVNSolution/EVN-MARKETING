# Bundled fonts

`app/layout.tsx` loads these checked-in files with `next/font/local`. Builds and
browsers do not request Google Fonts CSS or font binaries. Keep both OFL files
and this provenance document with distributed images (`/app/licenses/fonts`).

## Source

Downloaded individual files from the official [google/fonts repository](https://github.com/google/fonts)
at commit `e44c4b011a820c2cbe2fd2cfa8052037d7edb571` on 2026-09-22:

| Family | Original font | License |
| --- | --- | --- |
| Noto Sans KR | [NotoSansKR[wght].ttf](https://github.com/google/fonts/blob/e44c4b011a820c2cbe2fd2cfa8052037d7edb571/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf) | [OFL.txt](https://github.com/google/fonts/blob/e44c4b011a820c2cbe2fd2cfa8052037d7edb571/ofl/notosanskr/OFL.txt), copied verbatim to `NotoSansKR-OFL.txt` |
| Jost | [Jost[wght].ttf](https://github.com/google/fonts/blob/e44c4b011a820c2cbe2fd2cfa8052037d7edb571/ofl/jost/Jost%5Bwght%5D.ttf) | [OFL.txt](https://github.com/google/fonts/blob/e44c4b011a820c2cbe2fd2cfa8052037d7edb571/ofl/jost/OFL.txt), copied verbatim to `Jost-OFL.txt` |

Google Fonts metadata records these upstream revisions:

- Noto Sans KR: `notofonts/noto-cjk`, `523d033d6cb47f4a80c58a35753646f5c3608a78`.
- Jost: `indestructible-type/Jost`, `35f141c970538f1ed0f235789c19156b3ce2a762`.

The downloaded Google Fonts files above are the authoritative inputs for these
assets. They are licensed under SIL Open Font License 1.1; retain their copyright
and license notices.

## Conversion and behavior

Converted full TTF files to WOFF2 using Python 3.12, FontTools 4.65.0 and Brotli
1.2.0 in temporary tooling outside the application. No glyph subsetting, weight
instancing, outline editing, or font renaming was performed. Both normal-style
fonts retain their `wght` axis from 100 through 900. The app declares 400–900 for
Noto Sans KR and 400–800 for Jost, retaining the former maximum used for the bold
Latin logo. Existing CSS variables
`--font-korean` and `--font-latin`, the Jost-first font stack, and `display: swap`
are preserved. The original application used normal fonts; no italic asset is
added.

To reproduce with the pinned input files and tool versions:

```python
from fontTools.ttLib import TTFont

for name in ("NotoSansKR", "Jost"):
    with TTFont(f"{name}[wght].ttf", recalcTimestamp=False) as font:
        font.flavor = "woff2"
        font.save(f"{name}-variable.woff2")
```

The Korean WOFF2 is 3.73 MiB. Unlike the former unicode-range split,
the complete Korean file is preloaded as one asset per release URL; it is not fetched
incrementally by character coverage. Next serves both fonts as local static
assets. Conversion tools and source TTFs are not build or runtime dependencies.

## Sizes and SHA-256

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| Original `NotoSansKR[wght].ttf` | 10,414,588 | `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252` |
| Original `Jost[wght].ttf` | 134,996 | `6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076` |
| `../NotoSansKR-variable.woff2` | 3,908,716 | `f484190a87503ac2af2cf9771ec35122128453fe0cd92f4368117562d99547e6` |
| `../Jost-variable.woff2` | 50,544 | `34be248120246c294adfba1b7c119c03bb4aea6e743d7348a3275fa5809e9959` |
| `NotoSansKR-OFL.txt` | 4,388 | `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9` |
| `Jost-OFL.txt` | 4,384 | `1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5` |
