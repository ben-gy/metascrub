/** Shared types for metascrub. */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'unknown';

/** A single block of metadata discovered in the file. */
export interface MetaBlock {
  /** Stable id (segment kind + offset) for UI keys. */
  id: string;
  /** Human kind, e.g. "EXIF", "XMP", "IPTC", "PNG text (tEXt)". */
  kind: string;
  /** Byte offset where this block starts in the source. */
  offset: number;
  /** Total bytes this block occupies (including its header). */
  length: number;
  /** True if this block carries privacy-sensitive data we want to flag. */
  sensitive: boolean;
  /** Whether scrub() will remove this block. */
  willRemove: boolean;
  /** Short note for the UI, e.g. "contains GPS location". */
  note?: string;
}

/** Decoded, human-readable highlights pulled out of EXIF/XMP for the UI. */
export interface DecodedHighlights {
  gps?: { lat: number; lon: number };
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  software?: string;
  dateTime?: string;
  serialNumber?: string;
  /** True if the EXIF carried an embedded thumbnail (a hidden second image). */
  hasThumbnail?: boolean;
  /** Free-form extra tags worth showing. */
  extra?: Record<string, string>;
}

/** The full report produced by scanning a file. */
export interface ScanReport {
  format: ImageFormat;
  byteLength: number;
  blocks: MetaBlock[];
  highlights: DecodedHighlights;
  /** Total bytes of metadata that scrub() would remove. */
  removableBytes: number;
}

/** Result of scrubbing a file. */
export interface ScrubResult {
  output: Uint8Array;
  removed: MetaBlock[];
  bytesRemoved: number;
  /** Re-scan of the output to prove it is clean. */
  verify: ScanReport;
}

/** Worker request/response protocol. */
export type WorkerRequest =
  | { type: 'scan'; id: number; name: string; bytes: ArrayBuffer }
  | { type: 'scrub'; id: number; name: string; bytes: ArrayBuffer };

export type WorkerResponse =
  | { type: 'scan:progress'; id: number; stage: string; pct: number }
  | { type: 'scan:done'; id: number; report: ScanReport; thumb?: ArrayBuffer; thumbType?: string }
  | { type: 'scrub:progress'; id: number; stage: string; pct: number }
  | { type: 'scrub:done'; id: number; output: ArrayBuffer; removed: MetaBlock[]; bytesRemoved: number; verify: ScanReport }
  | { type: 'error'; id: number; message: string };
