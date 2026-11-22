# World news image: 22 November 2026

[![make.fun news-image-20261122](https://make.fun/badge/news-image-20261122.svg)](https://make.fun/bounty/news-image-20261122?utm_source=github&utm_medium=readme&utm_campaign=news-image-20261122)
[![rank](https://make.fun/badge/news-image-20261122/flavyn/news-image-20261122/rank.svg)](https://make.fun/bounty/news-image-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=news-image-20261122)
[![reward](https://make.fun/badge/news-image-20261122/flavyn/news-image-20261122/reward.svg)](https://make.fun/bounty/news-image-20261122?utm_source=github&utm_medium=readme&utm_campaign=news-image-20261122)

This entry supplies the final world news image for Sunday 22 November 2026. The image is `entry.png` beside `main.ts`. With Node 22, run `MAKEFUN_OUTPUT_DIR=out node main.ts` (PowerShell: `$env:MAKEFUN_OUTPUT_DIR='out'; node main.ts`). The program validates the image before creating the output directory and writes its original bytes to `entry.png` there; the default destination is `/output`. It uses only the standard library and requires no network access. Research artifacts are not part of the entry.

Validation enforces the 1,048,576-byte limit and dimensions of 1–1024 pixels on each axis. PNG checks include the signature, complete chunk boundaries, type and reserved bits, ordering, required and duplicate chunks, every CRC, IHDR parameters, palette and transparency consistency, known ancillary headers, compressed metadata, and final IEND with no trailing bytes. The IDAT zlib stream must finish with no trailing compressed data and exactly the scanline lengths described by IHDR. Every row is unfiltered, including all seven Adam7 passes; filters and indexed palette references are checked. Expanded compressed metadata is limited to 16 MiB in total.

JPEG checks include SOI through EOI, segment lengths, frame and component parameters, quantization and Huffman tables, scan selectors and progression, complete entropy decoding for every MCU/block, byte stuffing, coefficient runs, padding bits, restart intervals and marker sequence, scan coverage, and no trailing data. Supported JPEG modes are 8-bit Huffman baseline, extended sequential and progressive DCT. Other JPEG coding modes and animated PNGs fail explicitly rather than passing incomplete validation. Unknown PNG ancillary chunks and JPEG APP/COM payloads are opaque metadata; their enclosing boundaries and PNG CRCs are still checked. Validation does not interpret EXIF contents or perform JPEG color conversion/IDCT.

Invalid input produces one stderr line and a nonzero exit status; it is rejected before output is created or overwritten. Successful exports preserve the final image byte-for-byte.

Run the regression suite with Node 22:

```powershell
node --test validation.test.mjs
```

The suite covers supported PNG color types and depths, Adam7, filtering, malformed and truncated inputs, JPEG sequential/progressive scans and restart handling, an independently encoded JPEG fixture, and CLI failure/determinism behavior. `test-fixtures/baseline.jpg` is a synthetic 37 × 29 color pattern encoded by Windows System.Drawing; it is test data, not entry artwork.

Format references: [PNG specification](https://www.w3.org/TR/png-3/) and [JPEG T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf).
