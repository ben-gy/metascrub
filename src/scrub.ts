/**
 * The metascrub engine.
 *
 * Hand-written, dependency-free parsers for JPEG, PNG and WebP that:
 *   1. scan() — enumerate every metadata block and decode the sensitive bits.
 *   2. scrub() — losslessly remove those blocks. We never touch the pixel data:
 *      JPEG entropy data, PNG IDAT chunks and WebP bitstream chunks are copied
 *      byte-for-byte, so the image is bit-identical minus the metadata.
 *
 * Everything is defensive: a truncated or malformed file yields a partial
 * report instead of throwing, and scrub() falls back to returning the input
 * unchanged for formats it does not understand.
 */

import { decodeExif } from './exif';
import type {
  DecodedHighlights,
  ImageFormat,
  MetaBlock,
  ScanReport,
  ScrubResult,
} from './types';

// ─── format detection ───────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectFormat(b: Uint8Array): ImageFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) {
    return 'webp';
  }
  return 'unknown';
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  const end = Math.min(start + len, b.length);
  for (let i = start; i < end; i++) {
    const c = b[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ─── JPEG ─────────────────────────────────────────────────────────────────

interface ScanInternal {
  blocks: MetaBlock[];
  highlights: DecodedHighlights;
}

function scanJpeg(b: Uint8Array): ScanInternal {
  const blocks: MetaBlock[] = [];
  let highlights: DecodedHighlights = {};
  let p = 2; // skip SOI (FFD8)

  while (p + 1 < b.length) {
    if (b[p] !== 0xff) {
      // Resync: skip fill bytes / corruption until the next marker.
      p++;
      continue;
    }
    let marker = b[p + 1];
    // Skip fill 0xFF bytes between marker prefix and code.
    while (marker === 0xff && p + 2 < b.length) {
      p++;
      marker = b[p + 1];
    }

    // Standalone markers with no length payload.
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS — entropy-coded scan data follows to EOI.

    if (p + 4 > b.length) break;
    const segLen = (b[p + 2] << 8) | b[p + 3]; // includes the 2 length bytes
    if (segLen < 2) break;
    const segStart = p;
    const segTotal = 2 + segLen; // marker (2) + payload (segLen, which counts its own 2 length bytes)
    if (segStart + segTotal > b.length) break; // truncated segment — stop rather than over-read
    const payloadStart = p + 4;

    const classified = classifyJpegSegment(b, marker, payloadStart, segLen - 2);
    if (classified) {
      blocks.push({
        id: `jpeg-${marker.toString(16)}-${segStart}`,
        kind: classified.kind,
        offset: segStart,
        length: segTotal,
        sensitive: classified.sensitive,
        willRemove: classified.remove,
        note: classified.note,
      });
      if (classified.exifTiff) {
        try {
          highlights = { ...highlights, ...decodeExif(classified.exifTiff) };
        } catch {
          /* malformed EXIF — ignore, block is still reported and removed */
        }
      }
    }

    p += segTotal;
  }

  return { blocks, highlights };
}

interface Classified {
  kind: string;
  sensitive: boolean;
  remove: boolean;
  note?: string;
  exifTiff?: Uint8Array;
}

function classifyJpegSegment(
  b: Uint8Array,
  marker: number,
  payloadStart: number,
  payloadLen: number,
): Classified | null {
  const head = ascii(b, payloadStart, 32);

  if (marker === 0xe1) {
    if (head.startsWith('Exif')) {
      // "Exif\0\0" (6 bytes) then the TIFF block.
      const tiff = b.subarray(payloadStart + 6, payloadStart + payloadLen);
      return {
        kind: 'EXIF',
        sensitive: true,
        remove: true,
        note: 'camera info, timestamps and possibly GPS location',
        exifTiff: tiff,
      };
    }
    if (head.includes('ns.adobe.com/xap')) {
      return { kind: 'XMP', sensitive: true, remove: true, note: 'editing history / descriptive tags' };
    }
    return { kind: 'APP1', sensitive: true, remove: true, note: 'application metadata' };
  }
  if (marker === 0xe0 && (head.startsWith('JFIF') || head.startsWith('JFXX'))) {
    return null; // structural — keep, do not report as metadata
  }
  if (marker === 0xe2) {
    if (head.startsWith('ICC_PROFILE')) return null; // colour profile — keep
    if (head.startsWith('MPF')) {
      return { kind: 'MPF', sensitive: true, remove: true, note: 'multi-picture container (may embed extra images)' };
    }
    return { kind: 'APP2', sensitive: false, remove: true, note: 'application metadata' };
  }
  if (marker === 0xed) {
    return { kind: 'IPTC / Photoshop', sensitive: true, remove: true, note: 'captions, credits, location names' };
  }
  if (marker === 0xee && head.startsWith('Adobe')) {
    return null; // Adobe colour-transform marker — keep
  }
  if (marker === 0xfe) {
    return { kind: 'Comment', sensitive: false, remove: true, note: 'embedded text comment' };
  }
  // Any other APPn (E3–EC, EF) — non-structural, often maker notes.
  if (marker >= 0xe3 && marker <= 0xef) {
    return { kind: `APP${marker - 0xe0}`, sensitive: false, remove: true, note: 'application / maker-note metadata' };
  }
  return null;
}

// ─── PNG ──────────────────────────────────────────────────────────────────

const PNG_REMOVE = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function scanPng(b: Uint8Array): ScanInternal {
  const blocks: MetaBlock[] = [];
  let highlights: DecodedHighlights = {};
  let p = 8; // skip signature

  while (p + 8 <= b.length) {
    const len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const type = ascii(b, p + 4, 4);
    const chunkTotal = 12 + len; // length(4) + type(4) + data(len) + crc(4)
    if (len < 0 || p + chunkTotal > b.length) break;

    if (PNG_REMOVE.has(type)) {
      const dataStart = p + 8;
      let kind = `PNG text (${type})`;
      let sensitive = false;
      let note: string | undefined = 'embedded text / metadata';
      if (type === 'eXIf') {
        kind = 'EXIF (PNG)';
        sensitive = true;
        note = 'camera info, timestamps and possibly GPS location';
        try {
          highlights = { ...highlights, ...decodeExif(b.subarray(dataStart, dataStart + len)) };
        } catch {
          /* ignore */
        }
      } else if (type === 'tIME') {
        kind = 'Timestamp (tIME)';
        note = 'last-modified time';
      } else {
        // text chunks may carry XMP
        const key = ascii(b, dataStart, 32);
        if (key.toLowerCase().includes('xml:com.adobe.xmp')) {
          kind = 'XMP (PNG)';
          sensitive = true;
          note = 'editing history / descriptive tags';
        }
      }
      blocks.push({
        id: `png-${type}-${p}`,
        kind,
        offset: p,
        length: chunkTotal,
        sensitive,
        willRemove: true,
        note,
      });
    }

    if (type === 'IEND') break;
    p += chunkTotal;
  }

  return { blocks, highlights };
}

// ─── WebP (RIFF) ────────────────────────────────────────────────────────────

const WEBP_REMOVE = new Set(['EXIF', 'XMP ']);

function scanWebp(b: Uint8Array): ScanInternal {
  const blocks: MetaBlock[] = [];
  let highlights: DecodedHighlights = {};
  let p = 12; // skip RIFF(4) + size(4) + WEBP(4)

  while (p + 8 <= b.length) {
    const fourcc = ascii(b, p, 4);
    const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (size < 0) break;
    const padded = size + (size & 1); // chunks are padded to an even byte boundary
    const chunkTotal = 8 + padded;
    if (p + chunkTotal > b.length + 1) break;

    if (WEBP_REMOVE.has(fourcc)) {
      const dataStart = p + 8;
      let kind = fourcc.trim() === 'XMP' ? 'XMP (WebP)' : 'EXIF (WebP)';
      let note = 'descriptive tags';
      let sensitive = true;
      if (fourcc === 'EXIF') {
        note = 'camera info, timestamps and possibly GPS location';
        try {
          highlights = { ...highlights, ...decodeExif(b.subarray(dataStart, dataStart + size)) };
        } catch {
          /* ignore */
        }
      }
      blocks.push({
        id: `webp-${fourcc.trim()}-${p}`,
        kind,
        offset: p,
        length: chunkTotal,
        sensitive,
        willRemove: true,
        note,
      });
    }

    p += chunkTotal;
  }

  return { blocks, highlights };
}

// ─── public scan ─────────────────────────────────────────────────────────────

export function scan(bytes: Uint8Array): ScanReport {
  const format = detectFormat(bytes);
  let internal: ScanInternal = { blocks: [], highlights: {} };
  if (format === 'jpeg') internal = scanJpeg(bytes);
  else if (format === 'png') internal = scanPng(bytes);
  else if (format === 'webp') internal = scanWebp(bytes);

  const removableBytes = internal.blocks
    .filter((blk) => blk.willRemove)
    .reduce((sum, blk) => sum + blk.length, 0);

  return {
    format,
    byteLength: bytes.byteLength,
    blocks: internal.blocks,
    highlights: internal.highlights,
    removableBytes,
  };
}

// ─── lossless removal ──────────────────────────────────────────────────────

/** Concatenate the file minus the byte ranges of the blocks marked for removal. */
function removeRanges(bytes: Uint8Array, blocks: MetaBlock[]): Uint8Array {
  const toRemove = blocks
    .filter((blk) => blk.willRemove)
    .sort((a, b) => a.offset - b.offset);
  if (toRemove.length === 0) return bytes.slice();

  const totalRemoved = toRemove.reduce((s, blk) => s + blk.length, 0);
  const out = new Uint8Array(bytes.byteLength - totalRemoved);
  let read = 0;
  let write = 0;
  for (const blk of toRemove) {
    const keep = blk.offset - read;
    out.set(bytes.subarray(read, read + keep), write);
    write += keep;
    read = blk.offset + blk.length;
  }
  out.set(bytes.subarray(read), write);
  return out;
}

/** After removing EXIF/XMP chunks from a WebP, fix the RIFF size and VP8X flags. */
function patchWebp(out: Uint8Array): Uint8Array {
  // RIFF size field = total file length - 8.
  const riffSize = out.byteLength - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;

  // Clear EXIF (0x08) and XMP (0x04) flag bits in the VP8X header if present.
  let p = 12;
  while (p + 8 <= out.byteLength) {
    const fourcc = ascii(out, p, 4);
    const size = out[p + 4] | (out[p + 5] << 8) | (out[p + 6] << 16) | (out[p + 7] << 24);
    const padded = size + (size & 1);
    if (fourcc === 'VP8X' && size >= 1) {
      out[p + 8] &= ~0x0c; // clear EXIF + XMP flags
      break;
    }
    p += 8 + padded;
  }
  return out;
}

export function scrub(bytes: Uint8Array): ScrubResult {
  const report = scan(bytes);
  const removed = report.blocks.filter((blk) => blk.willRemove);

  let output = removeRanges(bytes, report.blocks);
  if (report.format === 'webp' && removed.length > 0) {
    output = patchWebp(output);
  }

  const verify = scan(output);
  const bytesRemoved = bytes.byteLength - output.byteLength;

  return { output, removed, bytesRemoved, verify };
}
