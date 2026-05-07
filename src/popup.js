(function () {
  const $enabled = document.getElementById('enabled');
  const $run = document.getElementById('run');
  const $status = document.getElementById('status');
  const $options = document.getElementById('open-options');

  function setStatus(text, ok = true) {
    $status.textContent = text;
    $status.style.color = ok ? '' : '#cf222e';
    if (text) setTimeout(() => ($status.textContent = ''), 2000);
  }

  async function init() {
    const s = await window.GReadStorage.getSettings();
    $enabled.checked = !!s.enabled;
  }

  $enabled.addEventListener('change', async () => {
    await window.GReadStorage.setSettings({ enabled: $enabled.checked });
  });

  $run.addEventListener('click', async () => {
    $run.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        setStatus('No active tab', false);
        return;
      }
      if (!/^https:\/\/github\.com\/.+\/pull\/\d+\/(files|changes)/.test(tab.url || '')) {
        setStatus('Not a PR Files page', false);
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'run' });
      } catch (err) {
        // Content scripts not loaded yet (e.g. tab loaded before extension reload).
        // Inject both the page-world interceptor and the isolated content scripts.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/page-interceptor.js'],
          world: 'MAIN',
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/glob.js', 'src/storage.js', 'src/content.js'],
        });
        await chrome.tabs.sendMessage(tab.id, { type: 'run' });
      }
      setStatus('Done');
    } catch (e) {
      setStatus(e?.message || 'Failed', false);
    } finally {
      $run.disabled = false;
    }
  });

  const optionsUrl = (() => {
    try { return chrome.runtime.getURL('src/options.html'); } catch (_) { return '#'; }
  })();
  $options.href = optionsUrl;

  $options.addEventListener('click', async (e) => {
    e.preventDefault();
    if (chrome.runtime?.openOptionsPage) {
      try {
        await chrome.runtime.openOptionsPage();
        window.close();
        return;
      } catch (_) {}
    }
    try {
      await chrome.tabs.create({ url: optionsUrl });
      window.close();
      return;
    } catch (_) {}
    window.open(optionsUrl, '_blank');
  });

  init();
})();
