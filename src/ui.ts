/**
 * UI shell — builds the static markup (header, drop zone, results area, footer,
 * modals, event drawer), wires modal open/close, dark-mode toggle and the
 * drawer toggle, and exposes small rendering helpers used by main.ts.
 */

export interface ShellRefs {
  dropzone: HTMLElement;
  fileInput: HTMLInputElement;
  results: HTMLElement;
  drawer: HTMLElement;
  drawerBody: HTMLElement;
}

const SHELL = /* html */ `
  <header class="site-header">
    <div class="brand">
      <img src="/favicon.svg" alt="" class="brand-mark" width="28" height="28" />
      <span class="brand-name">metascrub</span>
    </div>
    <nav class="header-nav">
      <button class="nav-btn" data-open="how">How it works</button>
      <button class="nav-btn" data-open="threat">Threat model</button>
      <button class="nav-btn" data-open="about">About</button>
      <button class="nav-btn icon" id="drawer-toggle" title="Event log" aria-label="Toggle event log">≡</button>
      <button class="nav-btn icon" id="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">◑</button>
    </nav>
  </header>

  <main class="main-content">
    <section class="hero">
      <h1>Strip hidden metadata from your photos</h1>
      <p class="sub">
        Photos quietly carry <span class="glossary-link" data-term="exif">GPS location, camera serial, timestamps</span>
        and more. metascrub shows you what's hidden and removes it
        <span class="glossary-link" data-term="lossless">losslessly</span> — without ever uploading your image.
      </p>
      <button class="trust-badge" data-open="threat" type="button">
        🔒 Runs entirely in your browser. Your photos never leave your device.
      </button>
    </section>

    <section class="dropzone" id="dropzone" tabindex="0" role="button"
      aria-label="Drop images here, or press Enter to choose files">
      <div class="dz-inner">
        <div class="dz-icon">⬇</div>
        <div class="dz-title">Drop photos here</div>
        <div class="dz-hint">or click to choose · paste with ⌘/Ctrl + V</div>
        <div class="dz-formats">JPEG · PNG · WebP</div>
      </div>
      <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
    </section>

    <section class="results" id="results" aria-live="polite"></section>
  </main>

  <footer class="site-footer">
    <span>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more tools &amp; sites</a></span>
    <span class="footer-sep">·</span>
    <span>No uploads · no accounts · no tracking</span>
  </footer>

  <aside class="drawer" id="drawer" aria-hidden="true">
    <div class="drawer-inner" id="drawer-body"></div>
  </aside>

  <div class="modal-root" id="modal-root" hidden></div>
`;

const MODALS: Record<string, { title: string; body: string }> = {
  how: {
    title: 'How it works',
    body: /* html */ `
      <ol class="steps">
        <li><strong>Detect the format.</strong> metascrub reads the file's magic bytes to recognise a
          <span class="glossary-link" data-term="metadata">JPEG, PNG or WebP</span> — no upload, all in a Web Worker.</li>
        <li><strong>Walk the container.</strong> It steps through every segment or
          <span class="glossary-link" data-term="chunk">chunk</span>, separating the pixel data from the metadata blocks.</li>
        <li><strong>Flag what's sensitive.</strong> It decodes the
          <span class="glossary-link" data-term="exif">EXIF</span>,
          <span class="glossary-link" data-term="xmp">XMP</span> and
          <span class="glossary-link" data-term="iptc">IPTC</span> blocks and highlights
          <span class="glossary-link" data-term="gps-ifd">GPS coordinates</span>, camera serials,
          timestamps and any hidden <span class="glossary-link" data-term="thumbnail">thumbnail</span>.</li>
        <li><strong>Remove it losslessly.</strong> It rebuilds the file without those blocks, copying the
          image data byte-for-byte. The visible picture is
          <span class="glossary-link" data-term="lossless">unchanged</span>.</li>
        <li><strong>Verify.</strong> It re-scans the cleaned file and proves no metadata remains, then hands you
          a download. Nothing was sent anywhere.</li>
      </ol>`,
  },
  threat: {
    title: 'Threat model',
    body: /* html */ `
      <h3 class="tm-good">✓ Protected</h3>
      <ul>
        <li>Your image never leaves the device. Every byte is parsed and rewritten inside your browser tab.</li>
        <li>No cookies, fingerprinting, third-party fonts or error reporting. The only analytics is Cloudflare Web Analytics — anonymous, cookie-less page-view counts; no personal data, no cross-site tracking.</li>
        <li>No account, no API key, no quota. You can disconnect from the internet after the page loads and it still works.</li>
        <li>Removal is <span class="glossary-link" data-term="lossless">lossless</span>: pixels are copied untouched, so we add no new fingerprint and lose no quality.</li>
      </ul>
      <h3 class="tm-warn">⚠ Not protected</h3>
      <ul>
        <li>metascrub removes <em>container metadata</em> (EXIF / XMP / IPTC / PNG text chunks / WebP EXIF+XMP). It does
          <strong>not</strong> change pixels — anything <em>visible in the photo itself</em> (a face, a street sign, a
          reflection) stays. That's a cropping/redaction job, not a metadata job.</li>
        <li>GitHub Pages and Cloudflare log the initial page load like any website visit. No image data is in those requests.</li>
        <li>HEIC (iPhone .heic) isn't supported yet — convert to JPEG first.</li>
      </ul>
      <h3 class="tm-trust">Trust surface</h3>
      <ul>
        <li>The static site bundle, deployed by a GitHub Action and pinned to its commit.</li>
        <li>The TLS chain to <code>metascrub.benrichardson.dev</code>.</li>
        <li>No third-party runtime code at all — the parser is hand-written and ships in the bundle.</li>
      </ul>`,
  },
  about: {
    title: 'About metascrub',
    body: /* html */ `
      <p>metascrub is a privacy-first tool that shows you the hidden metadata in your photos and removes it
        without uploading anything. It exists because most "remove EXIF online" tools ask you to upload the very
        photo you're trying to protect.</p>
      <p>It's lossless: it deletes only the metadata bytes and copies your image data unchanged.</p>
      <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.
        Source: <a href="https://github.com/ben-gy/metascrub" target="_blank" rel="noopener">github.com/ben-gy/metascrub</a>.</p>
      <p class="muted">No uploads. No accounts. No tracking. MIT licensed.</p>`,
  },
};

export function mountShell(app: HTMLElement): ShellRefs {
  app.innerHTML = SHELL;

  // Modal wiring
  const modalRoot = app.querySelector('#modal-root') as HTMLElement;
  app.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openModal((el as HTMLElement).dataset.open!));
  });
  function openModal(key: string): void {
    const m = MODALS[key];
    if (!m) return;
    modalRoot.innerHTML = /* html */ `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${m.title}">
          <div class="modal-head">
            <h2>${m.title}</h2>
            <button class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">${m.body}</div>
        </div>
      </div>`;
    modalRoot.hidden = false;
    const close = () => {
      modalRoot.hidden = true;
      modalRoot.innerHTML = '';
    };
    modalRoot.querySelector('.modal-close')!.addEventListener('click', close);
    modalRoot.querySelector('.modal-backdrop')!.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalRoot.hidden) {
      modalRoot.hidden = true;
      modalRoot.innerHTML = '';
    }
  });

  // Drawer toggle
  const drawer = app.querySelector('#drawer') as HTMLElement;
  app.querySelector('#drawer-toggle')!.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  });

  // Theme toggle (persisted)
  const themeToggle = app.querySelector('#theme-toggle') as HTMLButtonElement;
  const applyTheme = (t: string) => document.documentElement.setAttribute('data-theme', t);
  const saved = localStorage.getItem('metascrub-theme');
  if (saved) applyTheme(saved);
  themeToggle.addEventListener('click', () => {
    const cur =
      document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('metascrub-theme', next);
  });

  return {
    dropzone: app.querySelector('#dropzone') as HTMLElement,
    fileInput: app.querySelector('#file-input') as HTMLInputElement,
    results: app.querySelector('#results') as HTMLElement,
    drawer,
    drawerBody: app.querySelector('#drawer-body') as HTMLElement,
  };
}

// ─── render helpers ──────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mapLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
}
