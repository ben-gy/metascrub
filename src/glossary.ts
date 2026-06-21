/**
 * Glossary — jargon → plain-English definitions surfaced as click-to-define
 * tooltips. Any element with class `.glossary-link` and a `data-term` matching
 * a key below becomes clickable.
 */

export const GLOSSARY: Record<string, string> = {
  metadata:
    'Hidden information stored alongside the pixels of a photo — where and when it was taken, what device took it, and editing history. It is invisible when you view the image but travels with the file.',
  exif:
    'EXIF (Exchangeable Image File Format) is the block of camera-written data inside most JPEGs and many PNGs/WebPs: GPS coordinates, timestamp, camera make/model, serial number, exposure settings and often a small embedded thumbnail.',
  xmp:
    'XMP (Extensible Metadata Platform) is an Adobe metadata format embedded as XML. It records editing history, captions, keywords, copyright and sometimes location names.',
  iptc:
    'IPTC is a metadata standard used by news and stock photography for captions, credits, copyright, keywords and place names. Stored inside a Photoshop resource block (JPEG APP13).',
  'gps-ifd':
    'The GPS Image File Directory is the sub-table of EXIF that holds latitude, longitude, altitude and sometimes a timestamp — the exact spot on Earth where the photo was taken.',
  lossless:
    'A change that does not re-compress or re-encode the image. metascrub deletes only the metadata bytes and copies the pixel data untouched, so the visible image is bit-for-bit identical to the original.',
  thumbnail:
    'Cameras often embed a small preview image inside the EXIF block. It can survive cropping or edits made by some apps, leaking the original framing. metascrub removes it.',
  riff:
    'RIFF is the container format WebP uses — a sequence of labelled chunks. metascrub drops the EXIF and XMP chunks and rewrites the container size so the file stays valid.',
  chunk:
    'PNG and WebP files are built from labelled blocks called chunks. Image chunks are kept; text/EXIF/XMP metadata chunks are removed.',
};

let tooltipEl: HTMLDivElement | null = null;

export function initGlossary(root: HTMLElement = document.body): void {
  root.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement)?.closest('.glossary-link') as HTMLElement | null;
    if (target) {
      ev.stopPropagation();
      const term = target.dataset.term ?? '';
      const def = GLOSSARY[term];
      if (def) showTooltip(target, def);
      return;
    }
    hideTooltip();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hideTooltip();
  });
  window.addEventListener('scroll', hideTooltip, true);
}

function showTooltip(anchor: HTMLElement, text: string): void {
  hideTooltip();
  const tip = document.createElement('div');
  tip.className = 'glossary-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  tooltipEl = tip;

  const r = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = r.left + window.scrollX;
  let top = r.bottom + window.scrollY + 8;
  if (left + tipRect.width > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - tipRect.width - 12);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}
