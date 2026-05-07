(function () {
  const $patterns = document.getElementById('patterns');
  const $tester = document.getElementById('tester');
  const $result = document.getElementById('tester-result');
  const $save = document.getElementById('save');
  const $reset = document.getElementById('reset');
  const $status = document.getElementById('status');

  function getPatterns() {
    return $patterns.value.split('\n');
  }

  function updateTester() {
    const path = $tester.value.trim();
    if (!path) {
      $result.textContent = '—';
      $result.className = 'result';
      return;
    }
    const patterns = getPatterns();
    const hit = window.GReadGlob.matchAny(path, patterns);
    if (hit) {
      const which = patterns.find((p) => {
        const t = (p || '').trim();
        if (!t || t.startsWith('#') || t.startsWith('!')) return false;
        try {
          return window.GReadGlob.compile(t).test(path);
        } catch (_) {
          return false;
        }
      });
      $result.textContent = which
        ? `Match → would mark as Viewed (matched by: ${which})`
        : 'Match → would mark as Viewed';
      $result.className = 'result match';
    } else {
      $result.textContent = 'No match → would not be touched';
      $result.className = 'result nomatch';
    }
  }

  function flashStatus(text) {
    $status.textContent = text;
    $status.classList.add('show');
    setTimeout(() => $status.classList.remove('show'), 1500);
  }

  async function load() {
    const settings = await window.GReadStorage.getSettings();
    $patterns.value = (settings.patterns || []).join('\n');
    updateTester();
  }

  async function save() {
    await window.GReadStorage.setSettings({ patterns: getPatterns() });
    flashStatus('Saved');
  }

  async function reset() {
    if (!confirm('Reset patterns to defaults?')) return;
    await window.GReadStorage.setSettings({
      patterns: window.GReadStorage.DEFAULTS.patterns,
    });
    await load();
    flashStatus('Reset');
  }

  $save.addEventListener('click', save);
  $reset.addEventListener('click', reset);
  $patterns.addEventListener('input', updateTester);
  $tester.addEventListener('input', updateTester);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  load();
})();
