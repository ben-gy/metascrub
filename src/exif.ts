/**
 * Minimal, defensive TIFF/EXIF reader.
 *
 * We only decode the handful of tags that matter for the privacy story —
 * GPS coordinates, camera make/model/serial, lens, software, timestamps,
 * and whether a hidden thumbnail is embedded. Everything is bounds-checked
 * so malformed input returns partial results rather than throwing.
 *
 * Input is the TIFF block: for a JPEG APP1 segment that is the bytes *after*
 * the "Exif\0\0" identifier; for a PNG eXIf chunk or WebP EXIF chunk it is the
 * chunk payload (which is already a bare TIFF stream).
 */

import type { DecodedHighlights } from './types';

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_LENS_MODEL = 0xa434;
const TAG_BODY_SERIAL = 0xa431;

const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface Entry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number; // absolute offset into the TIFF block where the value lives
}

interface IFD {
  entries: Map<number, Entry>;
  nextOffset: number;
}

class TiffReader {
  readonly view: DataView;
  readonly little: boolean;
  readonly len: number;

  private constructor(view: DataView, little: boolean, len: number) {
    this.view = view;
    this.little = little;
    this.len = len;
  }

  static create(tiff: Uint8Array): TiffReader | null {
    if (tiff.length < 8) return null;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const b0 = view.getUint8(0);
    const b1 = view.getUint8(1);
    let little: boolean;
    if (b0 === 0x49 && b1 === 0x49) little = true; // "II"
    else if (b0 === 0x4d && b1 === 0x4d) little = false; // "MM"
    else return null;
    const magic = little ? view.getUint16(2, true) : view.getUint16(2, false);
    if (magic !== 0x002a) return null;
    return new TiffReader(view, little, tiff.byteLength);
  }

  u16(off: number): number {
    return this.view.getUint16(off, this.little);
  }
  u32(off: number): number {
    return this.view.getUint32(off, this.little);
  }

  readIFD(offset: number): IFD | null {
    if (offset < 8 || offset + 2 > this.len) return null;
    const count = this.u16(offset);
    const entries = new Map<number, Entry>();
    let p = offset + 2;
    for (let i = 0; i < count; i++) {
      if (p + 12 > this.len) break;
      const tag = this.u16(p);
      const type = this.u16(p + 2);
      const cnt = this.u32(p + 4);
      const size = (TYPE_SIZES[type] ?? 0) * cnt;
      // If the value fits in 4 bytes it is inline; otherwise the 4 bytes are an offset.
      const valueOffset = size > 4 ? this.u32(p + 8) : p + 8;
      entries.set(tag, { tag, type, count: cnt, valueOffset });
      p += 12;
    }
    const nextOffset = p + 4 <= this.len ? this.u32(p) : 0;
    return { entries, nextOffset };
  }

  ascii(e: Entry): string {
    const start = e.valueOffset;
    const end = Math.min(start + e.count, this.len);
    if (start < 0 || start >= this.len) return '';
    let s = '';
    for (let i = start; i < end; i++) {
      const c = this.view.getUint8(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /** Read `count` RATIONALs as floating-point numbers. */
  rationals(e: Entry): number[] {
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const off = e.valueOffset + i * 8;
      if (off + 8 > this.len) break;
      const num = this.u32(off);
      const den = this.u32(off + 4);
      out.push(den === 0 ? 0 : num / den);
    }
    return out;
  }
}

function dmsToDecimal(dms: number[], ref: string): number | undefined {
  if (dms.length < 3) return undefined;
  const [deg, min, sec] = dms;
  let dec = deg + min / 60 + sec / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  // Round to 6 decimal places (~0.1 m precision) for display.
  return Math.round(dec * 1e6) / 1e6;
}

export function decodeExif(tiff: Uint8Array): DecodedHighlights {
  const out: DecodedHighlights = {};
  const r = TiffReader.create(tiff);
  if (!r) return out;

  const ifd0Offset = r.u32(4);
  const ifd0 = r.readIFD(ifd0Offset);
  if (!ifd0) return out;

  const make = ifd0.entries.get(TAG_MAKE);
  if (make && make.type === 2) out.cameraMake = r.ascii(make) || undefined;
  const model = ifd0.entries.get(TAG_MODEL);
  if (model && model.type === 2) out.cameraModel = r.ascii(model) || undefined;
  const software = ifd0.entries.get(TAG_SOFTWARE);
  if (software && software.type === 2) out.software = r.ascii(software) || undefined;
  const dt = ifd0.entries.get(TAG_DATETIME);
  if (dt && dt.type === 2) out.dateTime = r.ascii(dt) || undefined;

  // Embedded thumbnail lives in IFD1 (the "next" IFD after IFD0).
  if (ifd0.nextOffset && ifd0.nextOffset < r.len) {
    const ifd1 = r.readIFD(ifd0.nextOffset);
    if (ifd1 && ifd1.entries.size > 0) out.hasThumbnail = true;
  }

  // Exif sub-IFD: lens, body serial, original timestamp.
  // The pointer is a LONG; its inline value is the byte offset to the sub-IFD.
  const exifPtr = ifd0.entries.get(TAG_EXIF_IFD);
  if (exifPtr) {
    const subOffset = r.u32(exifPtr.valueOffset);
    const sub = r.readIFD(subOffset);
    if (sub) {
      const lens = sub.entries.get(TAG_LENS_MODEL);
      if (lens && lens.type === 2) out.lensModel = r.ascii(lens) || undefined;
      const serial = sub.entries.get(TAG_BODY_SERIAL);
      if (serial && serial.type === 2) out.serialNumber = r.ascii(serial) || undefined;
      if (!out.dateTime) {
        const dto = sub.entries.get(TAG_DATETIME_ORIGINAL);
        if (dto && dto.type === 2) out.dateTime = r.ascii(dto) || undefined;
      }
    }
  }

  // GPS sub-IFD.
  const gpsPtr = ifd0.entries.get(TAG_GPS_IFD);
  if (gpsPtr) {
    const gpsOffset = r.u32(gpsPtr.valueOffset);
    const gps = r.readIFD(gpsOffset);
    if (gps) {
      const latRefE = gps.entries.get(GPS_LAT_REF);
      const latE = gps.entries.get(GPS_LAT);
      const lonRefE = gps.entries.get(GPS_LON_REF);
      const lonE = gps.entries.get(GPS_LON);
      if (latE && lonE) {
        const latRef = latRefE ? r.ascii(latRefE) : 'N';
        const lonRef = lonRefE ? r.ascii(lonRefE) : 'E';
        const lat = dmsToDecimal(r.rationals(latE), latRef);
        const lon = dmsToDecimal(r.rationals(lonE), lonRef);
        if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
          out.gps = { lat, lon };
        }
      }
    }
  }

  return out;
}
