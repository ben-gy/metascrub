import { describe, expect, it } from 'vitest';
import { detectFormat, scan, scrub } from '../src/scrub';
import {
  buildJpeg,
  buildPng,
  buildWebp,
  basePngChunks,
  pngChunk,
  webpChunk,
  exifApp1,
  xmpApp1,
  jfifApp0,
  commentSeg,
  buildTiffWithGps,
  strBytes,
} from './fixtures';

describe('detectFormat', () => {
  it('detects JPEG', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });
  it('detects PNG', () => {
    expect(detectFormat(buildPng(basePngChunks()))).toBe('png');
  });
  it('detects WebP', () => {
    expect(detectFormat(buildWebp([webpChunk('VP8 ', [1, 2, 3])]))).toBe('webp');
  });
  it('returns unknown for arbitrary bytes', () => {
    expect(detectFormat(new Uint8Array([1, 2, 3, 4, 5]))).toBe('unknown');
  });
  it('returns unknown for empty input', () => {
    expect(detectFormat(new Uint8Array([]))).toBe('unknown');
  });
});

describe('JPEG scan + scrub', () => {
  const tiff = buildTiffWithGps();

  it('scans EXIF, XMP and comment but keeps JFIF', () => {
    const jpeg = buildJpeg([jfifApp0(), exifApp1(tiff), xmpApp1(), commentSeg('secret note')]);
    const report = scan(jpeg);
    expect(report.format).toBe('jpeg');
    const kinds = report.blocks.map((b) => b.kind);
    expect(kinds).toContain('EXIF');
    expect(kinds).toContain('XMP');
    expect(kinds).toContain('Comment');
    expect(kinds).not.toContain('APP0'); // JFIF kept, not reported
  });

  it('decodes GPS highlights from the EXIF', () => {
    const jpeg = buildJpeg([exifApp1(tiff)]);
    const report = scan(jpeg);
    expect(report.highlights.gps?.lat).toBeCloseTo(51.5, 4);
    expect(report.highlights.cameraMake).toBe('Canon');
  });

  it('losslessly removes metadata and preserves scan data + markers', () => {
    const scanData = [0xaa, 0xbb, 0xcc, 0xdd];
    const jpeg = buildJpeg([jfifApp0(), exifApp1(tiff), commentSeg('x')], scanData);
    const { output, verify, bytesRemoved } = scrub(jpeg);
    // SOI + EOI intact
    expect([output[0], output[1]]).toEqual([0xff, 0xd8]);
    expect([output[output.length - 2], output[output.length - 1]]).toEqual([0xff, 0xd9]);
    // scan data still present contiguously
    const hay = Array.from(output);
    expect(containsSeq(hay, scanData)).toBe(true);
    // nothing removable remains
    expect(verify.blocks.filter((b) => b.willRemove)).toHaveLength(0);
    expect(verify.highlights.gps).toBeUndefined();
    expect(bytesRemoved).toBeGreaterThan(0);
    // JFIF (APP0) survived
    expect(containsSeq(hay, strBytes('JFIF'))).toBe(true);
  });

  it('reports an already-clean JPEG as having nothing to remove', () => {
    const jpeg = buildJpeg([jfifApp0()]);
    const report = scan(jpeg);
    expect(report.removableBytes).toBe(0);
    expect(report.blocks.filter((b) => b.willRemove)).toHaveLength(0);
  });

  it('is idempotent — scrubbing a cleaned file removes nothing', () => {
    const jpeg = buildJpeg([exifApp1(tiff)]);
    const once = scrub(jpeg).output;
    const twice = scrub(once);
    expect(twice.bytesRemoved).toBe(0);
    expect(Array.from(twice.output)).toEqual(Array.from(once));
  });
});

describe('PNG scan + scrub', () => {
  it('removes text/eXIf/tIME chunks but keeps IHDR/IDAT/IEND', () => {
    const tiff = buildTiffWithGps();
    const chunks = [
      pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      pngChunk('tEXt', strBytes('Comment\0hello')),
      pngChunk('eXIf', Array.from(tiff)),
      pngChunk('IDAT', [0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
      pngChunk('IEND', []),
    ];
    const png = buildPng(chunks);
    const report = scan(png);
    expect(report.format).toBe('png');
    expect(report.blocks.map((b) => b.kind)).toEqual(
      expect.arrayContaining(['PNG text (tEXt)', 'EXIF (PNG)']),
    );
    expect(report.highlights.gps?.lat).toBeCloseTo(51.5, 4);

    const { output, verify } = scrub(png);
    const hay = Array.from(output);
    expect(containsSeq(hay, strBytes('IHDR'))).toBe(true);
    expect(containsSeq(hay, strBytes('IDAT'))).toBe(true);
    expect(containsSeq(hay, strBytes('IEND'))).toBe(true);
    expect(containsSeq(hay, strBytes('tEXt'))).toBe(false);
    expect(containsSeq(hay, strBytes('eXIf'))).toBe(false);
    expect(verify.blocks.filter((b) => b.willRemove)).toHaveLength(0);
  });

  it('flags an XMP-bearing iTXt chunk as sensitive', () => {
    const chunks = [
      pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      pngChunk('iTXt', strBytes('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')),
      pngChunk('IEND', []),
    ];
    const report = scan(buildPng(chunks));
    const xmp = report.blocks.find((b) => b.kind === 'XMP (PNG)');
    expect(xmp?.sensitive).toBe(true);
  });

  it('reports a metadata-free PNG as clean', () => {
    const report = scan(buildPng(basePngChunks()));
    expect(report.removableBytes).toBe(0);
  });
});

describe('WebP scan + scrub', () => {
  it('removes EXIF and XMP chunks and fixes the RIFF size', () => {
    const tiff = buildTiffWithGps();
    const webp = buildWebp([
      webpChunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // flags byte has EXIF+XMP bits set
      webpChunk('VP8 ', [1, 2, 3, 4]),
      webpChunk('EXIF', Array.from(tiff)),
      webpChunk('XMP ', strBytes('<x:xmpmeta/>')),
    ]);
    const report = scan(webp);
    expect(report.format).toBe('webp');
    expect(report.blocks.map((b) => b.kind)).toEqual(
      expect.arrayContaining(['EXIF (WebP)', 'XMP (WebP)']),
    );
    expect(report.highlights.gps?.lon).toBeCloseTo(-0.125, 4);

    const { output, verify } = scrub(webp);
    // RIFF size field equals total length - 8
    const riffSize = output[4] | (output[5] << 8) | (output[6] << 16) | (output[7] << 24);
    expect(riffSize).toBe(output.byteLength - 8);
    // VP8X EXIF+XMP flag bits cleared
    // locate VP8X payload first byte
    expect(scan(output).blocks.filter((b) => b.willRemove)).toHaveLength(0);
    expect(verify.highlights.gps).toBeUndefined();
    // keeps the image bitstream chunk
    expect(containsSeq(Array.from(output), strBytes('VP8 '))).toBe(true);
  });

  it('reports a metadata-free WebP as clean', () => {
    const webp = buildWebp([webpChunk('VP8 ', [1, 2, 3, 4])]);
    expect(scan(webp).removableBytes).toBe(0);
  });
});

describe('edge cases', () => {
  it('scan of unknown format returns an empty report', () => {
    const r = scan(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(r.format).toBe('unknown');
    expect(r.blocks).toHaveLength(0);
    expect(r.removableBytes).toBe(0);
  });

  it('scrub of unknown format returns the input unchanged', () => {
    const input = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const { output, bytesRemoved } = scrub(input);
    expect(bytesRemoved).toBe(0);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('does not throw on a truncated JPEG', () => {
    const jpeg = buildJpeg([exifApp1(buildTiffWithGps())]).subarray(0, 12);
    expect(() => scan(jpeg)).not.toThrow();
    expect(() => scrub(jpeg)).not.toThrow();
  });

  it('handles an empty buffer', () => {
    expect(() => scrub(new Uint8Array([]))).not.toThrow();
    expect(scan(new Uint8Array([])).format).toBe('unknown');
  });
});

/** True if `needle` appears as a contiguous subsequence of `hay`. */
function containsSeq(hay: number[], needle: number[]): boolean {
  if (needle.length === 0) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
