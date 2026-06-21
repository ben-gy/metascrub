/**
 * Byte-level builders for synthetic JPEG / PNG / WebP / TIFF test fixtures.
 * These let the tests assert exact scan/scrub behaviour without binary assets.
 */

const LE = true;

// ─── JPEG ─────────────────────────────────────────────────────────────────

export interface JpegSeg {
  marker: number; // e.g. 0xe1 for APP1
  payload: number[]; // bytes AFTER the 2-byte length field
}

/** Build a JPEG: SOI, the given marker segments, then SOS + scan data + EOI. */
export function buildJpeg(segs: JpegSeg[], scanData: number[] = [0x11, 0x22, 0x33]): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  for (const s of segs) {
    const len = s.payload.length + 2; // length field counts itself
    out.push(0xff, s.marker, (len >> 8) & 0xff, len & 0xff, ...s.payload);
  }
  // SOS marker with a tiny header, then entropy-coded scan data, then EOI.
  out.push(0xff, 0xda, 0x00, 0x02); // SOS with minimal length
  out.push(...scanData);
  out.push(0xff, 0xd9); // EOI
  return new Uint8Array(out);
}

export function strBytes(s: string): number[] {
  return Array.from(s).map((c) => c.charCodeAt(0));
}

/** APP1 EXIF segment payload = "Exif\0\0" + tiff bytes. */
export function exifApp1(tiff: Uint8Array): JpegSeg {
  return { marker: 0xe1, payload: [...strBytes('Exif'), 0, 0, ...tiff] };
}

export function xmpApp1(): JpegSeg {
  return { marker: 0xe1, payload: strBytes('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>') };
}

export function jfifApp0(): JpegSeg {
  return { marker: 0xe0, payload: [...strBytes('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0] };
}

export function commentSeg(text: string): JpegSeg {
  return { marker: 0xfe, payload: strBytes(text) };
}

// ─── PNG ──────────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC-32 (PNG polynomial) so chunks are well-formed.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  type: string;
  data: number[];
}

export function pngChunk(type: string, data: number[]): PngChunk {
  return { type, data };
}

export function buildPng(chunks: PngChunk[]): Uint8Array {
  const out: number[] = [...PNG_SIG];
  for (const c of chunks) {
    const typeBytes = strBytes(c.type);
    const len = c.data.length;
    out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    const crc = crc32([...typeBytes, ...c.data]);
    out.push(...typeBytes, ...c.data);
    out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  }
  return new Uint8Array(out);
}

/** A minimal valid-ish PNG with IHDR + IDAT + IEND and optional metadata chunks. */
export function basePngChunks(): PngChunk[] {
  return [
    pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), // 1x1, 8-bit RGB
    pngChunk('IDAT', [0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
    pngChunk('IEND', []),
  ];
}

// ─── WebP (RIFF) ────────────────────────────────────────────────────────────

export interface WebpChunk {
  fourcc: string; // 4 chars
  data: number[];
}

export function webpChunk(fourcc: string, data: number[]): WebpChunk {
  return { fourcc, data };
}

export function buildWebp(chunks: WebpChunk[]): Uint8Array {
  const body: number[] = [...strBytes('WEBP')];
  for (const c of chunks) {
    const fcc = strBytes(c.fourcc.padEnd(4, ' ')).slice(0, 4);
    const size = c.data.length;
    body.push(...fcc, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, ...c.data);
    if (size & 1) body.push(0); // pad to even
  }
  const riffSize = body.length;
  return new Uint8Array([
    ...strBytes('RIFF'),
    riffSize & 0xff,
    (riffSize >> 8) & 0xff,
    (riffSize >> 16) & 0xff,
    (riffSize >> 24) & 0xff,
    ...body,
  ]);
}

// ─── TIFF / EXIF (little-endian) ────────────────────────────────────────────

/**
 * Build a small EXIF TIFF block with Make, Model and a GPS sub-IFD.
 * Returns the bare TIFF stream (what scan() passes to decodeExif).
 */
export function buildTiffWithGps(): Uint8Array {
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);

  // header
  buf[0] = 0x49; // 'I'
  buf[1] = 0x49; // 'I'
  dv.setUint16(2, 0x002a, LE);
  dv.setUint32(4, 8, LE); // IFD0 at offset 8

  const ifd0 = 8;
  const ifd0Count = 3; // Make, Model, GPSInfo
  dv.setUint16(ifd0, ifd0Count, LE);
  const ifd0End = ifd0 + 2 + ifd0Count * 12 + 4; // 50
  dv.setUint32(ifd0End - 4, 0, LE); // next IFD = none

  let heap = ifd0End;

  // Make = "Canon\0" (6 bytes → out of line)
  const makeStr = 'Canon\0';
  const makeOff = heap;
  for (let i = 0; i < makeStr.length; i++) buf[heap++] = makeStr.charCodeAt(i);

  // GPS IFD location (after the Make string)
  const gpsIfd = heap;

  // write IFD0 entries
  let e = ifd0 + 2;
  writeEntry(dv, buf, e, 0x010f, 2, makeStr.length, makeOff, false); // Make → offset
  e += 12;
  writeEntryInline(dv, buf, e, 0x0110, 2, 4, strBytes('X9\0\0')); // Model inline "X9"
  e += 12;
  writeEntry(dv, buf, e, 0x8825, 4, 1, gpsIfd, false); // GPSInfo IFD pointer

  // GPS IFD
  const gpsCount = 4;
  dv.setUint16(gpsIfd, gpsCount, LE);
  const gpsEnd = gpsIfd + 2 + gpsCount * 12 + 4;
  dv.setUint32(gpsEnd - 4, 0, LE);
  heap = gpsEnd;

  const latOff = heap;
  writeRational(dv, heap, 51, 1); heap += 8;
  writeRational(dv, heap, 30, 1); heap += 8;
  writeRational(dv, heap, 0, 1); heap += 8;
  const lonOff = heap;
  writeRational(dv, heap, 0, 1); heap += 8;
  writeRational(dv, heap, 7, 1); heap += 8;
  writeRational(dv, heap, 30, 1); heap += 8;

  let g = gpsIfd + 2;
  writeEntryInline(dv, buf, g, 0x0001, 2, 2, strBytes('N\0')); // lat ref N
  g += 12;
  writeEntry(dv, buf, g, 0x0002, 5, 3, latOff, false); // lat (3 rationals)
  g += 12;
  writeEntryInline(dv, buf, g, 0x0003, 2, 2, strBytes('W\0')); // lon ref W
  g += 12;
  writeEntry(dv, buf, g, 0x0004, 5, 3, lonOff, false); // lon (3 rationals)

  return buf.slice(0, heap);
}

function writeEntry(
  dv: DataView,
  _buf: Uint8Array,
  off: number,
  tag: number,
  type: number,
  count: number,
  valueOrOffset: number,
  _inline: boolean,
): void {
  dv.setUint16(off, tag, LE);
  dv.setUint16(off + 2, type, LE);
  dv.setUint32(off + 4, count, LE);
  dv.setUint32(off + 8, valueOrOffset, LE);
}

function writeEntryInline(
  dv: DataView,
  buf: Uint8Array,
  off: number,
  tag: number,
  type: number,
  count: number,
  bytes: number[],
): void {
  dv.setUint16(off, tag, LE);
  dv.setUint16(off + 2, type, LE);
  dv.setUint32(off + 4, count, LE);
  for (let i = 0; i < 4; i++) buf[off + 8 + i] = bytes[i] ?? 0;
}

function writeRational(dv: DataView, off: number, num: number, den: number): void {
  dv.setUint32(off, num, LE);
  dv.setUint32(off + 4, den, LE);
}
