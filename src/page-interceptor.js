// Runs in the page's main world. Two jobs:
//   1. Wrap window.fetch so we can capture headers GitHub's React client
//      sends to /file_review (specifically X-Fetch-Nonce and
//      X-GitHub-Client-Version) and forward them to the content script.
//   2. Receive "mark-viewed" requests from the content script and execute
//      them as same-origin fetches (Origin: https://github.com), then post
//      the result back. This is necessary because content-script fetches
//      have an extension Origin which GitHub's verified-fetch rejects.
(function () {
  if (window.__greadextInterceptorInstalled) return;
  window.__greadextInterceptorInstalled = true;

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      const method =
        (init && init.method) ||
        (typeof input === 'object' && input && input.method) ||
        'GET';
      if (url && /\/file_review(\?|$)/.test(url) && /post/i.test(method)) {
        const h = {};
        const src = (init && init.headers) || (typeof input === 'object' && input && input.headers);
        if (src && typeof src.forEach === 'function') {
          src.forEach((v, k) => {
            h[String(k).toLowerCase()] = v;
          });
        } else if (src && typeof src === 'object') {
          for (const k of Object.keys(src)) h[k.toLowerCase()] = src[k];
        }
        window.postMessage({ __greadext: true, type: 'captured-headers', headers: h }, '*');
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  // Strip Unicode bidi marks GitHub adds around link text.
  const stripBidi = (s) => (s || '').replace(/[‎‏‪‫‬‭‮]/g, '').trim();

  function findEntryByPath(path) {
    const entries = document.querySelectorAll(
      '[class*="PullRequestDiffsList-module__diffEntry"], div.file[data-tagsearch-path], .file[data-tagsearch-path]'
    );
    for (const entry of entries) {
      const tag = entry.getAttribute && entry.getAttribute('data-tagsearch-path');
      if (tag === path) return entry;
      const link = entry.querySelector && entry.querySelector('a[href^="#diff-"]');
      if (link && stripBidi(link.textContent) === path) return entry;
    }
    return null;
  }

  function callReactOnClick(btn) {
    if (!btn) return false;
    const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'));
    if (!key) return false;
    const props = btn[key];
    if (!props || typeof props.onClick !== 'function') return false;
    try {
      const fakeEvent = {
        preventDefault: () => {},
        stopPropagation: () => {},
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        type: 'click',
        target: btn,
        currentTarget: btn,
        nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
      };
      props.onClick(fakeEvent);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clickToggleForPath(path) {
    const entry = findEntryByPath(path);
    if (!entry) return { found: false, reason: 'no-entry' };
    // Legacy checkbox path
    const cb = entry.querySelector('input.js-reviewed-checkbox, input[name="viewed"]');
    if (cb) {
      if (cb.checked) return { found: true, alreadyViewed: true };
      try { cb.click(); } catch (_) {}
      return { found: true, kind: 'checkbox' };
    }
    // New React button
    const btn = entry.querySelector('button[class*="MarkAsViewedButton-module"]');
    if (!btn) return { found: false, reason: 'no-toggle' };
    const pressed = btn.getAttribute('aria-pressed');
    if (pressed === 'true') return { found: true, alreadyViewed: true };
    const viaReact = callReactOnClick(btn);
    if (viaReact) return { found: true, kind: 'button-react' };
    try {
      btn.focus();
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 }));
      btn.click();
    } catch (_) {}
    return { found: true, kind: 'button-dom' };
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__greadext !== true) return;

    if (d.type === 'click-toggle') {
      const { id, path } = d;
      let result;
      try {
        result = clickToggleForPath(path);
      } catch (err) {
        result = { found: false, error: err && err.message };
      }
      window.postMessage(
        { __greadext: true, type: 'click-toggle-result', id, ...result },
        '*'
      );
      return;
    }

    if (d.type === 'mark-viewed') {
      const { id, url, headers, body } = d;
      try {
        const resp = await origFetch(url, {
          method: 'POST',
          credentials: 'include',
          headers,
          body,
        });
        let bodyText = null;
        if (!resp.ok) bodyText = await resp.text().catch(() => '');
        window.postMessage(
          {
            __greadext: true,
            type: 'mark-viewed-result',
            id,
            ok: resp.ok,
            status: resp.status,
            body: bodyText,
          },
          '*'
        );
      } catch (err) {
        window.postMessage(
          {
            __greadext: true,
            type: 'mark-viewed-result',
            id,
            ok: false,
            error: err && err.message,
          },
          '*'
        );
      }
      return;
    }
  });
})();
