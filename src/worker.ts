/**
 * Dedicated worker: runs all byte-parsing and scrubbing off the main thread,
 * plus decodes a small preview thumbnail with OffscreenCanvas. Image bytes are
 * transferred (zero-copy) in both directions.
 */

import { scan, scrub } from './scrub';
import type { WorkerRequest, WorkerResponse } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

async function makeThumb(bytes: Uint8Array): Promise<{ buf: ArrayBuffer; type: string } | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  try {
    const blob = new Blob([bytes as BlobPart]);
    const bitmap = await createImageBitmap(blob);
    const max = 480;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await out.arrayBuffer();
    return { buf, type: out.type };
  } catch {
    return null;
  }
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'scan') {
      const bytes = new Uint8Array(req.bytes);
      post({ type: 'scan:progress', id: req.id, stage: 'Reading bytes', pct: 20 });
      const report = scan(bytes);
      post({ type: 'scan:progress', id: req.id, stage: 'Decoding metadata', pct: 70 });
      const thumb = await makeThumb(bytes);
      post({ type: 'scan:progress', id: req.id, stage: 'Rendering preview', pct: 95 });
      const transfer: Transferable[] = thumb ? [thumb.buf] : [];
      post(
        {
          type: 'scan:done',
          id: req.id,
          report,
          thumb: thumb?.buf,
          thumbType: thumb?.type,
        },
        transfer,
      );
      return;
    }

    if (req.type === 'scrub') {
      const bytes = new Uint8Array(req.bytes);
      post({ type: 'scrub:progress', id: req.id, stage: 'Walking segments', pct: 30 });
      const result = scrub(bytes);
      post({ type: 'scrub:progress', id: req.id, stage: 'Verifying output', pct: 80 });
      // Hand back a standalone copy so the buffer is transferable.
      const out = result.output.slice().buffer;
      post(
        {
          type: 'scrub:done',
          id: req.id,
          output: out,
          removed: result.removed,
          bytesRemoved: result.bytesRemoved,
          verify: result.verify,
        },
        [out],
      );
      return;
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
