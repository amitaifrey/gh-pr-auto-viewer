// Content script — runs on https://github.com/*/*/pull/*/{files,changes}*
// Finds files whose paths match the user's glob patterns and toggles the
// "Viewed" control so GitHub collapses them. Supports both the legacy
// /files DOM and the new React-based /changes experience.
(function () {
  console.log('[GReadExt] v0.1.3 loaded on', location.href);
  const HANDLED_ATTR = 'data-greadext-handled';
  const CLICK_INTERVAL_MS = 80;
  const LRM_RE = /[‎‏‪-‮]/g;

  const FILE_SELECTORS = [
    // Legacy /files
    'div.file[data-tagsearch-path]',
    '.file[data-tagsearch-path]',
    // New /changes — virtualized row keyed by sha256(path). Stable data
    // attribute; GitHub's CSS-module class names are minified hashes now.
    '[data-path-digest]',
    // Older /changes builds that still emitted module-prefixed classes.
    '[class*="PullRequestDiffsList-module__diffEntry"]',
  ].join(',');
  // Class names no longer carry the component name, so match the toggle by
  // its accessible label ("Viewed" / "Not Viewed") and keep the old class
  // selector as a fallback.
  const VIEWED_LABEL_RE = /^(not )?viewed$/i;
  const LEGACY_VIEWED_BUTTON_SELECTOR = 'button[class*="MarkAsViewedButton-module"]';

  function isViewedButton(btn) {
    if (btn.matches(LEGACY_VIEWED_BUTTON_SELECTOR)) return true;
    return VIEWED_LABEL_RE.test((btn.getAttribute('aria-label') || '').trim());
  }

  function findViewedButton(root) {
    const legacy = root.querySelector(LEGACY_VIEWED_BUTTON_SELECTOR);
    if (legacy) return legacy;
    for (const btn of root.querySelectorAll('button[aria-label]')) {
      if (isViewedButton(btn)) return btn;
    }
    return null;
  }

  function findAllViewedButtons() {
    return Array.from(document.querySelectorAll('button[aria-label]')).filter(isViewedButton);
  }

  let settings = { patterns: [], enabled: true };
  let observer = null;
  let clickQueue = [];
  let queueTimer = null;

  async function loadSettings() {
    settings = await window.GReadStorage.getSettings();
  }

  function isPullFilesPage() {
    return /\/pull\/\d+\/(files|changes)(\b|$|[/?#])/.test(
      location.pathname + location.search
    );
  }

  // ---- path resolution ----
  // GitHub's diff anchors are `diff-<sha256(path)>`. The new UI often shows
  // only the basename, so we recover the full path by hashing candidate
  // strings (header text, embedded JSON) and keeping the one that matches.
  const DIGEST_RE = /^[0-9a-f]{64}$/;
  const hashCache = new Map(); // text -> hex digest
  const digestToPath = new Map(); // hex digest -> verified path
  let embeddedScannedFor = null;

  async function sha256Hex(text) {
    if (hashCache.has(text)) return hashCache.get(text);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    hashCache.set(text, hex);
    return hex;
  }

  function getDigest(fileEl) {
    const attr = fileEl.getAttribute?.('data-path-digest');
    if (attr && DIGEST_RE.test(attr)) return attr;
    const ids = [fileEl.id, fileEl.querySelector?.('[id^="diff-"]')?.id];
    for (const id of ids) {
      const m = id && id.match(/^diff-([0-9a-f]{64})$/);
      if (m) return m[1];
    }
    const href = fileEl.querySelector?.('a[href^="#diff-"]')?.getAttribute('href');
    const m = href && href.match(/^#diff-([0-9a-f]{64})/);
    return m ? m[1] : null;
  }

  function headerCandidates(fileEl) {
    const header = fileEl.querySelector('[data-diff-header-wrapper]') || fileEl;
    const out = new Set();
    const add = (s) => {
      const t = (s || '').replace(LRM_RE, '').trim();
      if (t && t.length <= 1000 && !t.includes('\n')) out.add(t);
    };
    const els = header.querySelectorAll('*');
    for (let i = 0; i < els.length && i < 400; i++) {
      const el = els[i];
      add(el.textContent);
      add(el.getAttribute('title'));
      add(el.getAttribute('value'));
      add(el.getAttribute('data-path'));
      add(el.getAttribute('data-file-path'));
    }
    return out;
  }

  // React pages ship their initial payload as JSON in <script> tags. Hash
  // every string under a key that looks like a path, once per page.
  async function scanEmbeddedPaths() {
    // Keyed on pathname: tree clicks change the #diff- hash, and re-parsing
    // the (large) payload for each would be wasteful.
    if (embeddedScannedFor === location.pathname) return;
    embeddedScannedFor = location.pathname;
    const strings = new Set();
    const walk = (node, key, depth) => {
      if (depth > 40 || node == null) return;
      if (typeof node === 'string') {
        if (/path|name/i.test(key || '') && node.length <= 1000 && !node.includes('\n')) {
          strings.add(node);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const v of node) walk(v, key, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const k in node) walk(node[k], k, depth + 1);
      }
    };
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try {
        walk(JSON.parse(s.textContent || 'null'), '', 0);
      } catch (_) {}
    }
    for (const s of strings) {
      digestToPath.set(await sha256Hex(s), s);
    }
  }

  // The file tree (#pr-file-tree) renders every file in the PR, even ones
  // whose diff row is virtualized away, and each tree item's id is the
  // file's full path.
  function treeAnchors() {
    return document.querySelectorAll('#pr-file-tree a[href^="#diff-"]');
  }

  function treeAnchorDigest(a) {
    const m = (a.getAttribute('href') || '').match(/^#diff-([0-9a-f]{64})/);
    return m ? m[1] : null;
  }

  // Resolve a digest to its verified path without needing the diff row.
  async function resolveDigest(digest) {
    if (digestToPath.has(digest)) return digestToPath.get(digest);
    const a = document.querySelector(`#pr-file-tree a[href="#diff-${digest}"]`);
    const id = a?.closest('li[role="treeitem"]')?.id;
    if (id && (await sha256Hex(id)) === digest) {
      digestToPath.set(digest, id);
      return id;
    }
    await scanEmbeddedPaths();
    return digestToPath.get(digest) || null;
  }

  // Returns { path, verified }. `verified` means sha256(path) matched the
  // entry's digest (or it came from the legacy data attribute), so it's
  // safe to send to the /file_review API.
  async function getFilePath(fileEl) {
    // Legacy
    const tag = fileEl.getAttribute?.('data-tagsearch-path');
    if (tag) return { path: tag, verified: true };

    const digest = getDigest(fileEl);
    if (digest) {
      const resolved = await resolveDigest(digest);
      if (resolved) return { path: resolved, verified: true };
      for (const c of headerCandidates(fileEl)) {
        const h = await sha256Hex(c);
        if (h === digest) {
          digestToPath.set(digest, c);
          return { path: c, verified: true };
        }
      }
    }

    // Unverified fallbacks: text of the diff anchor (may be just the
    // basename in the new UI), then other attributes.
    const link = fileEl.querySelector('a[href^="#diff-"]');
    const txt = link && (link.textContent || '').replace(LRM_RE, '').trim();
    const path =
      txt ||
      fileEl.querySelector?.('[data-path]')?.getAttribute('data-path') ||
      fileEl.querySelector?.('clipboard-copy[value]')?.getAttribute('value') ||
      null;
    return { path, verified: false };
  }

  // In GitHub's "optimized for large PRs" mode the usual per-file container
  // may be missing, but the Viewed buttons remain. Walk up from a button to
  // the nearest ancestor that also carries a diff anchor or digest — that
  // ancestor effectively is the per-file container.
  function findFileEntryFromButton(btn) {
    let el = btn.parentElement;
    for (let i = 0; i < 15 && el; i++) {
      if (el.hasAttribute('data-path-digest') || /^diff-[0-9a-f]{64}$/.test(el.id)) return el;
      if (el.querySelector('a[href^="#diff-"]')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function getViewedToggle(fileEl) {
    // Legacy: native checkbox
    const cb =
      fileEl.querySelector?.('input.js-reviewed-checkbox') ||
      fileEl.querySelector?.('input[name="viewed"]');
    if (cb) {
      return {
        kind: 'checkbox',
        el: cb,
        isViewed: () => !!cb.checked,
      };
    }
    // New: React button, matched by aria-label (class names are minified).
    const btn = findViewedButton(fileEl);
    if (btn) {
      return {
        kind: 'button',
        el: btn,
        isViewed: () => {
          const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
          const pressed = btn.getAttribute('aria-pressed');
          if (pressed === 'true') return true;
          if (pressed === 'false') return false;
          if (aria === 'viewed') return true;
          if (aria === 'not viewed') return false;
          return false;
        },
      };
    }
    // Button hasn't mounted yet (virtualized). Caller can still POST via API.
    return null;
  }

  function getPrBase() {
    const m = location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/);
    return m ? m[1] : null;
  }

  // GitHub's verified-fetch protocol: requires a per-session nonce + client version.
  function getFetchNonce() {
    // Try known meta tag names.
    const names = [
      'github-react-fetch-nonce',
      'github-fetch-nonce',
      'react-fetch-nonce',
      'fetch-nonce',
    ];
    for (const n of names) {
      const v = document.querySelector(`meta[name="${n}"]`)?.getAttribute('content');
      if (v) return v;
    }
    // Fallback: scan all meta tags for a v2: token shape.
    for (const m of document.querySelectorAll('meta[content]')) {
      const c = m.getAttribute('content') || '';
      if (/^v2:[a-f0-9-]+$/i.test(c)) return c;
    }
    return null;
  }

  function getClientVersion() {
    const meta =
      document.querySelector('meta[name="github-client-version"]')?.getAttribute('content') ||
      document.querySelector('meta[name="client-version"]')?.getAttribute('content');
    if (meta) return meta;
    // Newer pages carry it in the client-env JSON blob instead of a meta tag.
    const env = document.querySelector('script[type="application/json"][data-target="client-env"]');
    if (!env) return null;
    let found = null;
    const walk = (node, key, depth) => {
      if (found || depth > 10 || node == null) return;
      if (typeof node === 'string') {
        if (/version|sha/i.test(key || '') && /^[0-9a-f]{40}$/.test(node)) found = node;
        return;
      }
      if (typeof node === 'object') for (const k in node) walk(node[k], k, depth + 1);
    };
    try {
      walk(JSON.parse(env.textContent || 'null'), '', 0);
    } catch (_) {}
    return found;
  }

  // Captured headers from a real /file_review request observed on the page,
  // populated by the page-world interceptor we inject below.
  let capturedHeaders = null;

  function buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'GitHub-Verified-Fetch': 'true',
      'GitHub-Is-React': 'true',
    };
    const nonce = capturedHeaders?.['x-fetch-nonce'] || getFetchNonce();
    if (nonce) headers['X-Fetch-Nonce'] = nonce;
    const ver =
      capturedHeaders?.['x-github-client-version'] || getClientVersion();
    if (ver) headers['X-GitHub-Client-Version'] = ver;
    return headers;
  }

  // Forward a /file_review POST to the page-world interceptor so the request
  // runs with Origin: https://github.com (a content-script fetch would have
  // an extension origin, which GitHub's verified-fetch rejects).
  let nextRequestId = 1;
  const pendingRequests = new Map();

  async function markViewedAPI(filePath) {
    const prBase = getPrBase();
    if (!prBase) return { ok: false, reason: 'no pr base' };
    const url = `${prBase}/file_review`;
    const id = nextRequestId++;
    const promise = new Promise((resolve) => pendingRequests.set(id, resolve));
    window.postMessage(
      {
        __greadext: true,
        type: 'mark-viewed',
        id,
        url,
        headers: buildHeaders(),
        body: JSON.stringify({ path: filePath, viewed: 'viewed' }),
      },
      '*'
    );
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 10000)
    );
    const result = await Promise.race([promise, timeout]);
    pendingRequests.delete(id);
    if (!result.ok) {
      console.log(
        '[GReadExt] file_review POST',
        result.status || result.reason || result.error,
        filePath,
        (result.body || '').slice(0, 200)
      );
    }
    return result;
  }

  // The page-world interceptor (src/page-interceptor.js) posts captured
  // headers, fetch results, and click results back to us.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__greadext !== true) return;
    if (d.type === 'captured-headers' && d.headers) {
      capturedHeaders = d.headers;
      return;
    }
    if (d.type === 'mark-viewed-result' && d.id) {
      const resolve = pendingRequests.get(d.id);
      if (resolve) {
        pendingRequests.delete(d.id);
        resolve({ ok: !!d.ok, status: d.status, body: d.body, error: d.error });
      }
      return;
    }
    if (d.type === 'click-toggle-result' && d.id) {
      const resolve = pendingRequests.get(d.id);
      if (resolve) {
        pendingRequests.delete(d.id);
        resolve(d);
      }
    }
  });

  async function clickToggleViaBridge(path, digest) {
    const id = nextRequestId++;
    const promise = new Promise((resolve) => pendingRequests.set(id, resolve));
    window.postMessage({ __greadext: true, type: 'click-toggle', id, path, digest }, '*');
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ found: false, reason: 'timeout' }), 3000)
    );
    const result = await Promise.race([promise, timeout]);
    pendingRequests.delete(id);
    return result;
  }

  function enqueueClick(el) {
    clickQueue.push(el);
    if (queueTimer) return;
    const drain = () => {
      const target = clickQueue.shift();
      if (target && target.isConnected) {
        try {
          target.click();
        } catch (_) {}
      }
      if (clickQueue.length === 0) {
        queueTimer = null;
      } else {
        queueTimer = setTimeout(drain, CLICK_INTERVAL_MS);
      }
    };
    queueTimer = setTimeout(drain, 0);
  }

  // Dispatches a thorough mouse-click sequence so React/Primer button
  // handlers fire reliably (a bare el.click() can sometimes be ignored).
  function dispatchRealClick(btn) {
    if (!btn || !btn.isConnected) return;
    let x = 0, y = 0;
    try {
      const r = btn.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    } catch (_) {}
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    };
    try { btn.focus(); } catch (_) {}
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerType: 'mouse' })); } catch (_) {}
    try { btn.dispatchEvent(new MouseEvent('mousedown', base)); } catch (_) {}
    try { btn.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse' })); } catch (_) {}
    try { btn.dispatchEvent(new MouseEvent('mouseup', base)); } catch (_) {}
    try { btn.click(); } catch (_) {}
  }

  // HANDLED_ATTR is "<state>:<key>" so a virtualized row that React reuses
  // for a different file isn't skipped because of a stale mark.
  function entryKey(fileEl) {
    return getDigest(fileEl) || fileEl.getAttribute('data-tagsearch-path') || '';
  }

  // Per-PR outcome for each file digest, kept in memory so a row that the
  // virtualized list unmounts and remounts isn't re-marked (e.g. after the
  // user un-viewed it by hand). States: not-matched | viewed | pending
  // (API POST queued) | api-viewed (POSTed; row's UI may still be stale)
  // | api-failed.
  const digestState = new Map();
  const stateKey = (digest) => `${getPrBase()}|${digest}`;

  function markHandled(fileEl, key, state) {
    fileEl.setAttribute(HANDLED_ATTR, `${state}:${key}`);
    if (DIGEST_RE.test(key)) digestState.set(stateKey(key), state);
  }

  let warnedUnverified = false;

  async function processFile(fileEl, { force = false } = {}) {
    const key = entryKey(fileEl);
    const state = fileEl.getAttribute(HANDLED_ATTR);
    if (!force && (state === `viewed:${key}` || state === `not-matched:${key}`)) return;
    if (fileEl.getAttribute('data-greadext-busy') === '1') return;
    if (DIGEST_RE.test(key)) {
      const ds = digestState.get(stateKey(key));
      if (ds === 'pending') return; // off-screen POST in flight; rescanned after
      if (!force && (ds === 'viewed' || ds === 'not-matched')) {
        fileEl.setAttribute(HANDLED_ATTR, `${ds}:${key}`);
        return;
      }
      // api-viewed / api-failed fall through: sync the UI by clicking.
    }

    fileEl.setAttribute('data-greadext-busy', '1');
    try {
      const { path, verified } = await getFilePath(fileEl);
      if (!path) return; // try again later (children may not be mounted yet)
      if (!verified && !warnedUnverified) {
        warnedUnverified = true;
        console.log('[GReadExt] could not verify full path for', key, '— matching on', path);
      }

      if (!window.GReadGlob.matchAny(path, settings.patterns)) {
        markHandled(fileEl, key, 'not-matched');
        return;
      }

      const toggle = getViewedToggle(fileEl);
      if (toggle && toggle.isViewed()) {
        markHandled(fileEl, key, 'viewed');
        return;
      }

      // Ask the page-world to click the toggle — for the React button this
      // invokes onClick directly via __reactProps so React's own state +
      // network request fire (file visibly collapses, no refresh needed).
      const click = await clickToggleViaBridge(path, getDigest(fileEl));
      if (click.found) {
        if (click.alreadyViewed) {
          markHandled(fileEl, key, 'viewed');
          return;
        }
        // Wait up to 2s for the UI to reflect the change.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const t = getViewedToggle(fileEl);
          if (t && t.isViewed()) {
            markHandled(fileEl, key, 'viewed');
            return;
          }
        }
      }

      // Click didn't take effect (or the entry has no toggle yet). POST
      // directly so the file is at least saved server-side; also flip
      // aria attributes so the button visually reflects the change. Only
      // with a verified path — a bare basename would mark the wrong file.
      if (!verified) return;
      const result = await markViewedAPI(path);
      if (result.ok) {
        if (toggle && toggle.kind === 'button') {
          try {
            toggle.el.setAttribute('aria-pressed', 'true');
            toggle.el.setAttribute('aria-label', 'Viewed');
          } catch (_) {}
        }
        markHandled(fileEl, key, 'viewed');
      }
      // On failure leave HANDLED_ATTR unset so we retry on the next scan.
    } finally {
      fileEl.removeAttribute('data-greadext-busy');
    }
  }

  let lastReportedCount = -1;
  function scan({ force = false } = {}) {
    if (!isPullFilesPage()) return;
    let files = Array.from(document.querySelectorAll(FILE_SELECTORS));
    // `[data-path-digest]` rows and the old diffEntry class can both match
    // on some builds; keep only outermost containers.
    files = files.filter((el) => !el.parentElement?.closest(FILE_SELECTORS));
    if (files.length === 0) {
      // Large-PR optimized mode: derive entries by walking up from each
      // Viewed button to its nearest file-path-owning ancestor.
      const seen = new Set();
      findAllViewedButtons().forEach((btn) => {
        const entry = findFileEntryFromButton(btn);
        if (entry && !seen.has(entry)) {
          seen.add(entry);
          files.push(entry);
        }
      });
    }
    if (files.length !== lastReportedCount) {
      console.log('[GReadExt] scan: found', files.length, 'file containers');
      lastReportedCount = files.length;
    }
    files.forEach((el) => processFile(el, { force }));
    scanOffscreen();
  }

  // ---- off-screen files (virtualized /changes list) ----
  // The new UI keeps only the diff rows near the viewport in the DOM, so
  // most files have no toggle to click. Enumerate every file from the file
  // tree and mark matching, unmounted ones via the same /file_review POST
  // GitHub's own button sends. When such a row later mounts, processFile
  // clicks it once so React's state catches up.
  const API_INTERVAL_MS = 100;
  let offscreenRunning = false;
  let offscreenAgain = false;

  function isRowMounted(digest) {
    return !!(
      document.querySelector(`[data-path-digest="${digest}"]`) ||
      document.getElementById(`diff-${digest}`)
    );
  }

  async function scanOffscreen() {
    // Only the virtualized React UI needs this; legacy /files mounts every
    // file container.
    if (!document.querySelector('[data-path-digest]')) return;
    if (offscreenRunning) {
      offscreenAgain = true;
      return;
    }
    offscreenRunning = true;
    let marked = 0;
    let failed = 0;
    try {
      do {
        offscreenAgain = false;
        const digests = new Set();
        treeAnchors().forEach((a) => {
          const d = treeAnchorDigest(a);
          if (d) digests.add(d);
        });
        for (const d of digests) {
          if (!isPullFilesPage()) return;
          if (digestState.has(stateKey(d)) || isRowMounted(d)) continue;
          const path = await resolveDigest(d);
          if (!path) continue;
          if (!window.GReadGlob.matchAny(path, settings.patterns)) {
            digestState.set(stateKey(d), 'not-matched');
            continue;
          }
          digestState.set(stateKey(d), 'pending');
          const result = await markViewedAPI(path);
          digestState.set(stateKey(d), result.ok ? 'api-viewed' : 'api-failed');
          if (result.ok) marked++;
          else failed++;
          // The row may have mounted while the POST was in flight.
          if (isRowMounted(d)) scheduleRescan();
          await new Promise((r) => setTimeout(r, API_INTERVAL_MS));
        }
      } while (offscreenAgain);
    } finally {
      offscreenRunning = false;
      if (marked || failed) {
        console.log(`[GReadExt] off-screen: marked ${marked} file(s) viewed via API` +
          (failed ? `, ${failed} failed` : ''));
      }
    }
  }

  // Debounced full rescan — cheaper to scan all FILE_SELECTORS than to track
  // individual mutations, and avoids races where the React diff list is
  // added with all entries in one mutation batch we then mis-parse.
  let rescanTimer = null;
  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan();
    }, 150);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scheduleRescan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function clearHandled() {
    document
      .querySelectorAll(`[${HANDLED_ATTR}]`)
      .forEach((el) => el.removeAttribute(HANDLED_ATTR));
    document
      .querySelectorAll('[data-greadext-busy]')
      .forEach((el) => el.removeAttribute('data-greadext-busy'));
    const prefix = `${getPrBase()}|`;
    for (const [k, v] of digestState) {
      if (k.startsWith(prefix) && v !== 'pending') digestState.delete(k);
    }
  }

  async function run({ force = false } = {}) {
    await loadSettings();
    if (!force && !settings.enabled) return;
    if (!isPullFilesPage()) return;
    if (force) clearHandled();
    scan({ force });
    startObserver();
    // React may mount the diff list after document_idle. Retry a few times
    // so we don't depend solely on the mutation observer catching it.
    // React may mount the diff list well after document_idle on slow loads.
    // Keep retrying for ~15s so we catch late-mounted entries.
    [500, 1500, 3000, 5000, 8000, 12000, 16000].forEach((t) =>
      setTimeout(() => scan(), t)
    );
    setTimeout(() => {
      if (
        document.querySelectorAll(FILE_SELECTORS).length === 0 &&
        findAllViewedButtons().length === 0
      ) {
        diagnose();
      }
    }, 6000);
  }

  // ---- diagnostics (only when no file containers are found) ----
  let diagnosed = false;
  function diagnose() {
    if (diagnosed) return;
    diagnosed = true;
    try {
      const summary = {
        url: location.href,
        legacyFiles: document.querySelectorAll('[data-tagsearch-path]').length,
        pathDigestRows: document.querySelectorAll('[data-path-digest]').length,
        oldDiffEntries: document.querySelectorAll(
          '[class*="PullRequestDiffsList-module__diffEntry"]'
        ).length,
        virtualizedList: !!document.querySelector('[data-testid="virtualized-diffs-list"]'),
        progressiveList: !!document.querySelector('[data-testid="progressive-diffs-list"]'),
        viewedButtons: findAllViewedButtons().length,
        diffAnchors: document.querySelectorAll('a[href^="#diff-"]').length,
      };
      console.log(
        '%c[GReadExt] no files matched — diagnostics:',
        'color:#d29922;font-weight:bold'
      );
      console.log('[GReadExt-DUMP] ' + JSON.stringify(summary));
    } catch (e) {
      console.log('[GReadExt] diagnose error:', e.message);
    }
  }

  // Initial run
  run();

  // SPA navigations (Turbo + React Router)
  document.addEventListener('turbo:load', () => run());
  document.addEventListener('pjax:end', () => run());
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      run();
    }
  }, 1000);

  // React to settings changes
  window.GReadStorage.onChanged((changes) => {
    if (changes.patterns) settings.patterns = changes.patterns.newValue || [];
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
  });

  // Manual trigger from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'run') {
      run({ force: true }).then(() => sendResponse({ ok: true }));
      return true; // async response
    }
  });
})();
