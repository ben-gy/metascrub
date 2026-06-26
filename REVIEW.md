# metascrub — Build Review

This file exists only to create a reviewable PR. All code is already deployed on `main`.

**Merge this PR to acknowledge the build.** Closing without merging is also fine.

## Links

- **GitHub Pages:** https://ben-gy.github.io/metascrub/ *(redirects to the custom domain)*
- **Custom domain:** https://metascrub.benrichardson.dev

## What it is

Strip hidden metadata (GPS location, camera serial, timestamps, embedded thumbnails) from
JPEG/PNG/WebP photos — losslessly, in your browser. Hand-written container parsers, zero
runtime dependencies, no uploads.

## DNS

CNAME `metascrub` → `ben-gy.github.io` (Cloudflare, DNS-only) — already created.
