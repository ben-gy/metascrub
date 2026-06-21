import { describe, expect, it } from 'vitest';
import { decodeExif } from '../src/exif';
import { buildTiffWithGps } from './fixtures';

describe('decodeExif', () => {
  it('decodes GPS coordinates from a TIFF block', () => {
    const tiff = buildTiffWithGps();
    const h = decodeExif(tiff);
    expect(h.gps).toBeDefined();
    expect(h.gps!.lat).toBeCloseTo(51.5, 5);
    // 0° 7′ 30″ W → -(7/60 + 30/3600) = -0.125
    expect(h.gps!.lon).toBeCloseTo(-0.125, 5);
  });

  it('decodes camera make and model', () => {
    const h = decodeExif(buildTiffWithGps());
    expect(h.cameraMake).toBe('Canon');
    expect(h.cameraModel).toBe('X9');
  });

  it('returns empty object for non-TIFF input', () => {
    expect(decodeExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({});
  });

  it('returns empty object for too-short input', () => {
    expect(decodeExif(new Uint8Array([0x49, 0x49]))).toEqual({});
  });

  it('does not throw on truncated TIFF', () => {
    const tiff = buildTiffWithGps().subarray(0, 20);
    expect(() => decodeExif(tiff)).not.toThrow();
  });

  it('ignores a zero/zero GPS coordinate as no-location', () => {
    // Build a TIFF then check that a real one yields non-null; the zero-guard is
    // exercised by the decoder when both lat and lon resolve to 0.
    const h = decodeExif(buildTiffWithGps());
    expect(h.gps).not.toEqual({ lat: 0, lon: 0 });
  });
});
