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

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__greadext !== true) return;
    if (d.type !== 'mark-viewed') return;
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
  });
})();
