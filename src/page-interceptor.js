// Runs in the page's main world. Bridge for the content script:
//   1. "click-toggle" — locate a diff entry by file path and invoke its
//      MarkAsViewed button's onClick handler directly via __reactProps so
//      React's own state + network request fire (file collapses without
//      a refresh). Legacy /files checkboxes are handled too.
//   2. "mark-viewed" — fall-through POST to /file_review using the page's
//      same-origin context (so GitHub's verified-fetch accepts it). Used
//      only when the click path can't reach a toggle.
// No fetch wrapping — we used to wrap window.fetch to capture GitHub's
// per-session X-Fetch-Nonce, but every unrelated page fetch failure got
// blamed on our wrapper's stack frame. We now read the nonce from the
// page's meta tags instead (see content.js#getFetchNonce).
(function () {
  if (window.__greadextInterceptorInstalled) return;
  window.__greadextInterceptorInstalled = true;

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
    // Large-PR optimized mode: walk up from each viewed button to find an
    // ancestor whose file-path link matches.
    const buttons = document.querySelectorAll('button[class*="MarkAsViewedButton-module"]');
    for (const btn of buttons) {
      let el = btn.parentElement;
      for (let i = 0; i < 15 && el; i++) {
        const link = el.querySelector('a[href^="#diff-"]');
        if (link && stripBidi(link.textContent) === path) return el;
        el = el.parentElement;
      }
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
    const cb = entry.querySelector('input.js-reviewed-checkbox, input[name="viewed"]');
    if (cb) {
      if (cb.checked) return { found: true, alreadyViewed: true };
      try { cb.click(); } catch (_) {}
      return { found: true, kind: 'checkbox' };
    }
    const btn = entry.querySelector('button[class*="MarkAsViewedButton-module"]');
    if (!btn) return { found: false, reason: 'no-toggle' };
    if (btn.getAttribute('aria-pressed') === 'true') return { found: true, alreadyViewed: true };
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
        const resp = await fetch(url, {
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
