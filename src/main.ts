/**
 * metascrub — entry point. Owns the drop/paste/pick ingestion, the per-file
 * worker RPC (scan then scrub) and the result-card rendering. No heavy logic
 * lives here; parsing happens in the worker, formatting in ui.ts.
 */

import './styles/main.css';
import { mountShell, formatBytes, escapeHtml, mapLink } from './ui';
import { emit, mountEventDrawer } from './eventlog';
import { initGlossary } from './glossary';
import type { ScanReport, MetaBlock, WorkerRequest, WorkerResponse } from './types';

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');

const refs = mountShell(app);
mountEventDrawer(refs.drawerBody);
initGlossary(document.body);
emit('system', 'ok', 'metascrub ready — everything runs locally in your browser');

// ─── worker + RPC ────────────────────────────────────────────────────────────

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
type ProgressFn = (stage: string, pct: number) => void;
interface Pending {
  onProgress: ProgressFn;
  resolve: (msg: WorkerResponse) => void;
  reject: (err: Error) => void;
}
const pending = new Map<number, Pending>();

worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
  const msg = ev.data;
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.type === 'scan:progress' || msg.type === 'scrub:progress') {
    p.onProgress(msg.stage, msg.pct);
  } else if (msg.type === 'error') {
    pending.delete(msg.id);
    p.reject(new Error(msg.message));
  } else {
    pending.delete(msg.id);
    p.resolve(msg);
  }
});
worker.addEventListener('error', (e) => emit('system', 'err', `worker error: ${e.message}`));

function call(req: Omit<WorkerRequest, 'id'>, transfer: Transferable[], onProgress: ProgressFn): Promise<WorkerResponse> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { onProgress, resolve, reject });
    worker.postMessage({ ...req, id }, transfer);
  });
}

// ─── ingestion ───────────────────────────────────────────────────────────────

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isCandidate(file: File): boolean {
  if (SUPPORTED.has(file.type)) return true;
  return /\.(jpe?g|png|webp)$/i.test(file.name);
}

function pickFiles(): void {
  refs.fileInput.click();
}

refs.dropzone.addEventListener('click', pickFiles);
refs.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickFiles();
  }
});
refs.fileInput.addEventListener('change', () => {
  if (refs.fileInput.files) handleFiles(Array.from(refs.fileInput.files));
  refs.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  refs.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    refs.dropzone.classList.add('dragging');
  }),
);
['dragleave', 'drop'].forEach((evt) =>
  refs.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragleave' && refs.dropzone.contains((e as DragEvent).relatedTarget as Node)) return;
    refs.dropzone.classList.remove('dragging');
  }),
);
refs.dropzone.addEventListener('drop', (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (dt?.files?.length) handleFiles(Array.from(dt.files));
});

window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.files;
  if (items?.length) {
    handleFiles(Array.from(items));
    emit('ui', 'info', 'pasted image from clipboard');
  }
});

function handleFiles(files: File[]): void {
  const usable = files.filter(isCandidate);
  const rejected = files.length - usable.length;
  if (rejected > 0) emit('ui', 'warn', `${rejected} file(s) skipped — only JPEG, PNG and WebP are supported`);
  for (const f of usable) void processFile(f);
}

// ─── per-file pipeline ───────────────────────────────────────────────────────

async function processFile(file: File): Promise<void> {
  const card = createCard(file.name);
  refs.results.prepend(card.el);
  emit('scan', 'info', `scanning ${file.name}`, { size: formatBytes(file.size) });

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    card.fail(`Could not read the file: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    card.setStage('Scanning…', 10);
    const scanMsg = (await call({ type: 'scan', name: file.name, bytes }, [bytes], (stage, pct) =>
      card.setStage(stage, pct),
    )) as Extract<WorkerResponse, { type: 'scan:done' }>;

    const report = scanMsg.report;
    if (scanMsg.thumb) card.setThumb(scanMsg.thumb, scanMsg.thumbType ?? 'image/png');
    emit('scan', 'ok', `${file.name}: found ${report.blocks.length} metadata block(s)`, {
      format: report.format,
      removable: formatBytes(report.removableBytes),
    });
    card.renderReport(file, report);
  } catch (err) {
    card.fail(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    emit('scan', 'err', `scan failed for ${file.name}`);
  }
}

// ─── card rendering ──────────────────────────────────────────────────────────

interface Card {
  el: HTMLElement;
  setStage: (label: string, pct: number) => void;
  setThumb: (buf: ArrayBuffer, type: string) => void;
  renderReport: (file: File, report: ScanReport) => void;
  fail: (message: string) => void;
}

function createCard(name: string): Card {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = /* html */ `
    <div class="card-top">
      <div class="thumb" aria-hidden="true"><div class="thumb-ph">🖼</div></div>
      <div class="card-meta">
        <div class="card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="card-tags"></div>
      </div>
    </div>
    <div class="progress" hidden><div class="bar"></div><span class="progress-label"></span></div>
    <div class="card-body"></div>
  `;
  const thumb = el.querySelector('.thumb') as HTMLElement;
  const tags = el.querySelector('.card-tags') as HTMLElement;
  const progress = el.querySelector('.progress') as HTMLElement;
  const bar = el.querySelector('.bar') as HTMLElement;
  const progressLabel = el.querySelector('.progress-label') as HTMLElement;
  const body = el.querySelector('.card-body') as HTMLElement;

  function setStage(label: string, pct: number): void {
    progress.hidden = false;
    bar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    progressLabel.textContent = label;
  }
  function clearStage(): void {
    progress.hidden = true;
  }
  function setThumb(buf: ArrayBuffer, type: string): void {
    const url = URL.createObjectURL(new Blob([buf], { type }));
    thumb.innerHTML = `<img src="${url}" alt="preview" />`;
  }
  function fail(message: string): void {
    clearStage();
    body.innerHTML = `<div class="error">⚠ ${escapeHtml(message)}</div>`;
  }

  function renderReport(file: File, report: ScanReport): void {
    clearStage();
    tags.innerHTML =
      `<span class="tag fmt">${report.format.toUpperCase()}</span>` +
      `<span class="tag">${formatBytes(report.byteLength)}</span>`;

    if (report.format === 'unknown') {
      body.innerHTML = `<div class="error">Unsupported or unrecognised format. metascrub handles JPEG, PNG and WebP.</div>`;
      return;
    }

    const removable = report.blocks.filter((b) => b.willRemove);
    if (removable.length === 0) {
      body.innerHTML = `<div class="clean">✓ Already clean — no removable metadata found in this image.</div>`;
      return;
    }

    body.innerHTML =
      renderHighlights(report) +
      renderBlocks(report.blocks) +
      `<div class="actions">
         <button class="btn primary scrub-btn">Scrub ${removable.length} block${removable.length > 1 ? 's' : ''} · save ${formatBytes(report.removableBytes)}</button>
       </div>
       <div class="scrub-out"></div>`;

    const scrubBtn = body.querySelector('.scrub-btn') as HTMLButtonElement;
    scrubBtn.addEventListener('click', () => void doScrub(file, scrubBtn));
    scrubBtn.focus();
  }

  async function doScrub(file: File, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Scrubbing…';
    emit('scrub', 'info', `scrubbing ${file.name}`);
    try {
      const buf = await file.arrayBuffer();
      setStage('Scrubbing…', 20);
      const msg = (await call({ type: 'scrub', name: file.name, bytes: buf }, [buf], (stage, pct) =>
        setStage(stage, pct),
      )) as Extract<WorkerResponse, { type: 'scrub:done' }>;
      clearStage();

      const remaining = msg.verify.blocks.filter((b) => b.willRemove).length;
      const out = el.querySelector('.scrub-out') as HTMLElement;
      const cleanName = withSuffix(file.name);
      const mime = mimeFor(msg.verify.format);
      const blob = new Blob([msg.output], { type: mime });

      emit('scrub', remaining === 0 ? 'ok' : 'warn', `${file.name} scrubbed`, {
        removed: formatBytes(msg.bytesRemoved),
        remaining,
      });

      out.innerHTML = /* html */ `
        <div class="verify ${remaining === 0 ? 'ok' : 'warn'}">
          ${remaining === 0
            ? `✓ Verified clean — removed ${escapeHtml(formatBytes(msg.bytesRemoved))} of metadata. The image is byte-for-byte identical otherwise.`
            : `⚠ ${remaining} block(s) could not be removed. Removed ${escapeHtml(formatBytes(msg.bytesRemoved))}.`}
        </div>
        <div class="actions out-actions">
          <button class="btn primary dl-btn">Download cleaned image</button>
          <button class="btn copy-btn">Copy</button>
          <button class="btn share-btn" hidden>Share</button>
        </div>`;

      const url = URL.createObjectURL(blob);
      const dl = out.querySelector('.dl-btn') as HTMLButtonElement;
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = cleanName;
        a.click();
        emit('io', 'ok', `downloaded ${cleanName}`);
      });

      const copy = out.querySelector('.copy-btn') as HTMLButtonElement;
      copy.addEventListener('click', async () => {
        try {
          if (mime !== 'image/png') {
            // Clipboard reliably accepts PNG only; re-wrap is out of scope, so guide the user.
            throw new Error('clipboard supports PNG only — use Download for this format');
          }
          await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
          copy.textContent = 'Copied ✓';
          emit('io', 'ok', 'copied cleaned image to clipboard');
          setTimeout(() => (copy.textContent = 'Copy'), 1800);
        } catch (err) {
          copy.textContent = 'Copy failed';
          emit('io', 'warn', `copy failed: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => (copy.textContent = 'Copy'), 2200);
        }
      });

      const share = out.querySelector('.share-btn') as HTMLButtonElement;
      const shareFile = new File([blob], cleanName, { type: mime });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [shareFile] })) {
        share.hidden = false;
        share.addEventListener('click', async () => {
          try {
            await navigator.share({ files: [shareFile], title: cleanName });
            emit('io', 'ok', 'shared cleaned image');
          } catch {
            /* user cancelled */
          }
        });
      }

      btn.textContent = 'Scrubbed ✓';
    } catch (err) {
      clearStage();
      btn.disabled = false;
      btn.textContent = 'Retry scrub';
      const out = el.querySelector('.scrub-out') as HTMLElement;
      out.innerHTML = `<div class="error">⚠ Scrub failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
      emit('scrub', 'err', `scrub failed for ${file.name}`);
    }
  }

  return { el, setStage, setThumb, renderReport, fail };
}

function renderHighlights(report: ScanReport): string {
  const h = report.highlights;
  const rows: string[] = [];
  if (h.gps) {
    rows.push(
      `<div class="hl danger">
        <span class="hl-k">📍 GPS location</span>
        <span class="hl-v">${h.gps.lat}, ${h.gps.lon}
          <a href="${mapLink(h.gps.lat, h.gps.lon)}" target="_blank" rel="noopener">view on map ↗</a></span>
      </div>`,
    );
  }
  const add = (k: string, v?: string) => {
    if (v) rows.push(`<div class="hl"><span class="hl-k">${k}</span><span class="hl-v">${escapeHtml(v)}</span></div>`);
  };
  add('📷 Camera', [h.cameraMake, h.cameraModel].filter(Boolean).join(' '));
  add('🔭 Lens', h.lensModel);
  add('🔢 Serial number', h.serialNumber);
  add('🕑 Taken', h.dateTime);
  add('🛠 Software', h.software);
  if (h.hasThumbnail) rows.push(`<div class="hl"><span class="hl-k">🖼 Embedded thumbnail</span><span class="hl-v">present</span></div>`);
  if (rows.length === 0) return '';
  return `<div class="highlights"><div class="hl-title">What's hidden in this photo</div>${rows.join('')}</div>`;
}

function renderBlocks(blocks: MetaBlock[]): string {
  if (blocks.length === 0) return '';
  const items = blocks
    .map(
      (b) => `<li class="${b.sensitive ? 'sensitive' : ''}">
        <span class="blk-kind">${escapeHtml(b.kind)}</span>
        <span class="blk-size">${formatBytes(b.length)}</span>
        ${b.note ? `<span class="blk-note">${escapeHtml(b.note)}</span>` : ''}
      </li>`,
    )
    .join('');
  return `<details class="blocks"><summary>Metadata blocks (${blocks.length})</summary><ul>${items}</ul></details>`;
}

function withSuffix(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-clean`;
  return `${name.slice(0, dot)}-clean${name.slice(dot)}`;
}

function mimeFor(fmt: string): string {
  if (fmt === 'jpeg') return 'image/jpeg';
  if (fmt === 'png') return 'image/png';
  if (fmt === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
