# metascrub

**Strip hidden metadata from your photos before you share them — losslessly, in your browser.**

Live: https://metascrub.benrichardson.dev

---

## what it is

Every photo a phone or camera produces carries a hidden payload: the GPS coordinates of
where it was taken (often your home), the exact timestamp, the camera's make, model and
serial number, the editing software, and sometimes a small embedded thumbnail that can
survive cropping. None of it is visible when you look at the picture, but all of it travels
with the file when you post or email it.

metascrub shows you exactly what's hidden in an image and removes it — **without the file
ever leaving your device**, and **without re-compressing the pixels**. Most "remove EXIF
online" tools ask you to upload the very photo you're trying to protect to a server you
don't control. metascrub does the whole job in your browser tab, so the image stays on
your machine, and the cleaned output is byte-for-byte identical to the original apart from
the metadata that was removed.

It's for anyone about to share a photo publicly — a marketplace seller, a parent posting to
a forum, a journalist or lawyer handling sensitive images — who wants proof the location
and device fingerprints are gone.

## how it works

Everything runs in a dedicated Web Worker so the UI never freezes. For each file:

1. **Detect** the format from its magic bytes (JPEG, PNG or WebP).
2. **Walk the container** segment by segment (JPEG markers) or chunk by chunk (PNG / WebP
   RIFF), separating the image data from the metadata blocks.
3. **Decode the sensitive bits** — the EXIF TIFF tree is parsed to surface GPS latitude/
   longitude (with a map link), camera make/model/serial, lens, timestamps, software and
   whether a hidden thumbnail is present.
4. **Remove losslessly** — the file is rebuilt without the metadata blocks while the pixel
   data is copied verbatim. No re-encode, no quality loss.
5. **Verify** — the cleaned output is re-scanned to prove no metadata remains, then offered
   as a download / clipboard copy / share.

### what gets removed

| Format | Removed | Kept (structural / colour) |
|--------|---------|----------------------------|
| JPEG | APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), APP2 MPF, COM comments, other maker-note APPn | SOI/EOI, JFIF (APP0), ICC profile (APP2), Adobe (APP14), entropy-coded scan data |
| PNG | `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME` | IHDR, PLTE, IDAT, IEND, gAMA/cHRM/sRGB/iCCP and all other chunks |
| WebP | `EXIF`, `XMP ` chunks (and the matching VP8X flag bits; RIFF size is rewritten) | VP8/VP8L bitstream, ALPH, ANIM/ANMF, ICCP |

## browser APIs used

- **File API + DataTransfer** — drag-drop, paste (⌘/Ctrl+V) and tap-to-pick input.
- **ArrayBuffer / DataView / TypedArrays** — byte-level container parsing (the whole engine).
- **Web Workers (ES module)** — all parsing and scrubbing off the main thread.
- **Transferable objects** — zero-copy hand-off of image bytes to and from the worker.
- **OffscreenCanvas + createImageBitmap** — decode a small preview thumbnail in the worker.
- **URL.createObjectURL** — deliver the cleaned file as a download.
- **Clipboard API** — copy the cleaned image (PNG).
- **Web Share API** — one-tap share on mobile, where supported.
- **Service Worker (vite-plugin-pwa)** — offline-capable after first load.

## security / privacy model

**Protected**
- Your image never leaves the device — every byte is parsed and rewritten in your tab.
- No cookies, fingerprinting, third-party fonts or error reporting. The only analytics is Cloudflare Web Analytics — anonymous, cookie-less page-view counts; no personal data, no cross-site tracking.
- No account, no API key, no quota. Works fully offline once the page has loaded.
- Removal is lossless: pixels are copied untouched, so no new fingerprint is added.

**Not protected**
- metascrub removes *container metadata*. It does **not** alter pixels — anything *visible
  in the photo itself* (a face, a street sign, a reflection) stays. That's a redaction job.
- GitHub Pages / Cloudflare log the initial page-load request like any website visit. No
  image data is in those requests.
- HEIC (iPhone `.heic`) is not supported yet — convert to JPEG first.

**Trust model**
- The static site bundle, deployed by the GitHub Action and pinned to its commit.
- The TLS chain to `metascrub.benrichardson.dev`.
- No third-party runtime code at all — the parser is hand-written and ships in the bundle.

## stack

- Vite 6 + vanilla TypeScript
- `vite-plugin-pwa` for offline support (the only build-time dependency of note)
- Vitest for unit tests (25 tests covering the JPEG/PNG/WebP parsers and the EXIF decoder)
- GitHub Pages for hosting, deployed via GitHub Actions

**No runtime dependencies.** All format parsing is hand-written against the JPEG, PNG and
WebP/RIFF specs, which keeps the trust surface tiny and the bundle small (~22 KB JS gzipped
to ~8 KB, plus an ~8 KB worker). No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics — no personal data, no cross-site tracking.

## local development

```bash
npm install
npm run dev      # vite dev server on :5173
npm test         # run the vitest suite
npm run build    # produce dist/ for deploy
npm run preview  # serve dist/ locally
```

## deploying

A push to `main` triggers `.github/workflows/deploy.yml`, which runs the tests, builds, and
deploys `dist/` to GitHub Pages. The custom domain is set via `public/CNAME` — point a CNAME
DNS record for `metascrub.benrichardson.dev` at `ben-gy.github.io`.

## license

MIT — see [LICENSE](./LICENSE).
