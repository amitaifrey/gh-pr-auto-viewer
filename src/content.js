// Content script — runs on https://github.com/*/*/pull/*/{files,changes}*
// Finds files whose paths match the user's glob patterns and toggles the
// "Viewed" control so GitHub collapses them. Supports both the legacy
// /files DOM and the new React-based /changes experience.
(function () {
  console.log('[GReadExt] v0.1.4 loaded on', location.href);
  const HANDLED_ATTR = 'data-greadext-handled';
  const CLICK_INTERVAL_MS = 80;
  const LRM_RE = /[‎‏‪-‮]/g;

  const FILE_SELECTORS = [
    // Legacy /files
    'div.file[data-tagsearch-path]',
    '.file[data-tagsearch-path]',
    // New /changes — CSS-modules class with hash; match the prefix.
    '[class*="PullRequestDiffsList-module__diffEntry"]',
  ].join(',');

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

  function getFilePath(fileEl) {
    // Legacy
    const tag = fileEl.getAttribute?.('data-tagsearch-path');
    if (tag) return tag;
    // New: file path is the text of the first anchor pointing at the diff anchor.
    const link = fileEl.querySelector('a[href^="#diff-"]');
    if (link) {
      const txt = (link.textContent || '').replace(LRM_RE, '').trim();
      if (txt) return txt;
    }
    // Other fallbacks
    return (
      fileEl.querySelector?.('[data-path]')?.getAttribute('data-path') ||
      fileEl.querySelector?.('clipboard-copy[value]')?.getAttribute('value') ||
      null
    );
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
    // New: React button. Class hash rotates, so match the module prefix.
    const btn = fileEl.querySelector?.('button[class*="MarkAsViewedButton-module"]');
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
    return (
      document.querySelector('meta[name="github-client-version"]')?.getAttribute('content') ||
      document.querySelector('meta[name="client-version"]')?.getAttribute('content') ||
      null
    );
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

  async function clickToggleViaBridge(path) {
    const id = nextRequestId++;
    const promise = new Promise((resolve) => pendingRequests.set(id, resolve));
    window.postMessage({ __greadext: true, type: 'click-toggle', id, path }, '*');
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

  async function processFile(fileEl, { force = false } = {}) {
    const state = fileEl.getAttribute(HANDLED_ATTR);
    if (!force && (state === 'viewed' || state === 'not-matched')) return;
    if (fileEl.getAttribute('data-greadext-busy') === '1') return;

    const path = getFilePath(fileEl);
    if (!path) return; // try again later (children may not be mounted yet)

    if (!window.GReadGlob.matchAny(path, settings.patterns)) {
      fileEl.setAttribute(HANDLED_ATTR, 'not-matched');
      return;
    }

    const toggle = getViewedToggle(fileEl);
    if (toggle && toggle.isViewed()) {
      fileEl.setAttribute(HANDLED_ATTR, 'viewed');
      return;
    }

    fileEl.setAttribute('data-greadext-busy', '1');
    try {
      // Ask the page-world to click the toggle — for the React button this
      // invokes onClick directly via __reactProps so React's own state +
      // network request fire (file visibly collapses, no refresh needed).
      const click = await clickToggleViaBridge(path);
      if (click.found) {
        // Wait up to 2s for the UI to reflect the change.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const t = getViewedToggle(fileEl);
          if (t && t.isViewed()) {
            fileEl.setAttribute(HANDLED_ATTR, 'viewed');
            return;
          }
        }
      }

      // Click didn't take effect (or the entry has no toggle yet). POST
      // directly so the file is at least saved server-side; also flip
      // aria attributes so the button visually reflects the change.
      const result = await markViewedAPI(path);
      if (result.ok) {
        if (toggle && toggle.kind === 'button') {
          try {
            toggle.el.setAttribute('aria-pressed', 'true');
            toggle.el.setAttribute('aria-label', 'Viewed');
          } catch (_) {}
        }
        fileEl.setAttribute(HANDLED_ATTR, 'viewed');
      }
      // On failure leave HANDLED_ATTR unset so we retry on the next scan.
    } finally {
      fileEl.removeAttribute('data-greadext-busy');
    }
  }

  let lastReportedCount = -1;
  function scan({ force = false } = {}) {
    if (!isPullFilesPage()) return;
    const files = document.querySelectorAll(FILE_SELECTORS);
    if (files.length !== lastReportedCount) {
      console.log('[GReadExt] scan: found', files.length, 'file containers');
      lastReportedCount = files.length;
    }
    files.forEach((el) => processFile(el, { force }));
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
      if (document.querySelectorAll(FILE_SELECTORS).length === 0) diagnose();
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
        newDiffEntries: document.querySelectorAll(
          '[class*="PullRequestDiffsList-module__diffEntry"]'
        ).length,
        progressiveList: !!document.querySelector('[data-testid="progressive-diffs-list"]'),
        viewedButtons: document.querySelectorAll(
          'button[class*="MarkAsViewedButton-module"]'
        ).length,
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
