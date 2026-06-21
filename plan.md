# Tool Plan: metascrub

## Overview
- **Name:** metascrub
- **Repo name:** metascrub
- **Tagline:** Strip hidden metadata from your photos before you share them — losslessly, in your browser.

## Problem It Solves
Every photo from a phone or camera carries a payload of hidden metadata: GPS coordinates
of where it was taken (often your home), the exact timestamp, the camera's serial number,
the software used, and sometimes a thumbnail that survives cropping. When someone posts
or emails a photo, all of that travels with it. People Google "remove location from photo",
"strip exif online", "remove metadata before posting" — and the tools they find ask them
to **upload the very photo they're trying to keep private to a stranger's server**. That's
backwards. metascrub shows you exactly what's hidden in your image and removes it without
the file ever leaving your device — and without re-compressing the pixels, so quality is
untouched.

## Why This Must Be Client-Side
- **Privacy:** the whole point is to protect a sensitive photo. Uploading it to a SaaS to
  "clean" it defeats the purpose and is the dominant flaw of every incumbent.
- **Sensitive-data handling:** GPS home coordinates, faces, NDA product shots — none of it
  should touch a third-party server.
- **Speed/offline:** byte-surgery on a JPEG is instant locally; no upload round-trip. Once
  loaded the tool works fully offline.
- **No-account friction:** no signup, no quota, no watermark.

## Browser APIs / Libraries Used
| API / Library | What it does for us | Fallback if unsupported |
|---------------|---------------------|-------------------------|
| File API + DataTransfer | Drag-drop, paste (Cmd/Ctrl+V), tap-to-pick input | N/A — hard requirement |
| ArrayBuffer / DataView / TypedArrays | Byte-level parsing of JPEG/PNG/WebP container structure | N/A — core |
| Web Workers (ES module) | Parse + scrub off the main thread; UI never freezes | Main-thread fallback |
| Transferable objects | Zero-copy hand-off of image bytes to/from worker | Structured clone copy |
| OffscreenCanvas | Decode a small preview thumbnail inside the worker | Main-thread `<canvas>` |
| URL.createObjectURL | Deliver the cleaned file as a download | N/A |
| Clipboard API | Copy the cleaned image to the clipboard | Download button always present |
| Web Share API | One-tap share of the cleaned file on mobile | Download button always present |
| Cache API (via Service Worker) | Offline-capable after first load | Works online only |

## Workflow (input → process → output)
1. User drops, pastes, or picks one or more images (JPEG / PNG / WebP).
2. Worker scans the bytes and reports **every** metadata block found — decoding the scary
   ones (GPS latitude/longitude with a map link, camera make/model + serial, timestamps,
   software, XMP/IPTC blocks, embedded thumbnails).
3. User clicks "Scrub" — the worker performs **lossless** segment surgery: it walks the
   container and drops the metadata segments while copying the image data byte-for-byte
   (no re-encode, no quality loss), then re-scans the output to prove it's clean.
4. User downloads the cleaned file, copies it to the clipboard, or shares it. A
   before/after metadata table shows exactly what was removed.

## Non-Goals
- No pixel editing, cropping, or compression (that's pdf-crush's / a different tool's job).
- No batch ZIP export in v1 (scrub each file, download individually).
- No HEIC support in v1 (browsers can't reliably decode it without a WASM codec; show a
  clear "convert to JPEG first" message).
- No cloud sync — ever.
- No metadata *editing* (only viewing and wholesale removal).

## Target Audience
Someone about to post a photo of their kid in the backyard to a public forum, or sell an
item on Facebook Marketplace, who just read that photos leak your home GPS — non-technical,
privacy-anxious, on a laptop or phone, wants proof it worked. Also: journalists, lawyers,
and OSINT-aware users who need a verifiable, no-upload scrub.

## Style Direction
**Tone:** calm, trustworthy, reassuring — privacy as relief, not paranoia.
**Colour palette:** warm off-white surfaces, deep slate text, a single trustworthy teal
accent for primary actions; amber for "found sensitive data" warnings, green for "clean".
The warning/clean colour story is functional, not decorative.
**UI density:** spacious.
**Dark/light theme:** light-first; respect `prefers-color-scheme: dark` as a warm graphite
dark mode.
**Reference tools for feel:** [Squoosh](https://squoosh.app) for the input→result clarity,
[1Password](https://1password.com) for the calm-security tone.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite (single workflow, no React needed).
- **Key libraries:** none at runtime — all parsing is hand-written against the JPEG/PNG/WebP
  specs (keeps the trust surface tiny and the bundle small). `vite-plugin-pwa` for offline.
- **Worker strategy:** single dedicated ES-module worker that owns scan + scrub + thumbnail.
  Image bytes are transferred (zero-copy) both ways.
- **Storage:** none for user data. `localStorage` holds only the dark-mode preference.

## Privacy & Trust Model
**Protected**
- The image never leaves the device. All parsing and scrubbing happens in your tab.
- No analytics, cookies, third-party fonts, telemetry, or error reporting.
- No account, no API key, no network calls during processing (verify in DevTools → Network).

**Not protected**
- GitHub Pages (and Cloudflare in front of it) log the initial HTML/JS/CSS fetch, like any
  site visit. No image data is in those requests.
- metascrub removes container-level metadata (EXIF/XMP/IPTC/PNG text chunks/WebP EXIF+XMP).
  It does **not** alter pixels, so any information *visible in the image itself* (a face, a
  street sign, a reflection) is untouched — that's a cropping/redaction job, not a metadata
  job. The Threat Model modal states this explicitly.

**Trust surface**
- The static site bundle (deployed by the GitHub Action, pinned to its commit).
- The TLS chain to `metascrub.benrichardson.dev` (Cloudflare DNS → ben-gy.github.io).
- No third-party runtime code at all.

## UX Required Surfaces
- Big calm drop zone: drag, paste (Cmd/Ctrl+V), tap-to-pick, keyboard focus.
- Per-file metadata report card: format, size, list of found blocks, decoded GPS/camera/
  timestamps, "sensitive" badges.
- Determinate progress (per-file, per-stage) with an aria-live region.
- "Scrub" primary action + re-scan verification ("✓ no metadata remains").
- Output: Download cleaned file · Copy to clipboard · Share (where supported).
- Event log drawer (Dropwell pattern) streaming scan/scrub steps + byte counts.
- How-It-Works modal (5 steps: detect format → walk segments → flag sensitive → strip
  losslessly → verify).
- Threat Model modal (Protected / Not Protected / Trust surface).
- About modal with benrichardson.dev attribution + source link.
- Glossary tooltips for EXIF, XMP, IPTC, GPS IFD, lossless, etc.
- Keyboard: Escape closes modals, Cmd/Ctrl+V pastes, Enter triggers Scrub on focused card.
- Sticky footer "Built by benrichardson.dev".
