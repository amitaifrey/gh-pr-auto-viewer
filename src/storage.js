// Settings persistence — chrome.storage.sync wrapper.
(function () {
  const DEFAULT_PATTERNS = [
    '# Default generated-file patterns. Lines starting with # are comments.',
    '# Use ** to match any depth, * for any chars except /, ! to negate.',
    '',
    '**/*.pb.go',
    '**/*_pb.js',
    '**/*_pb.ts',
    '**/*_pb2.py',
    '**/*_pb2_grpc.py',
    '**/*.generated.*',
    '**/generated/**',
    '**/__generated__/**',
    '**/*.gen.go',
    '',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
    'go.sum',
    '',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
  ];

  const DEFAULTS = {
    patterns: DEFAULT_PATTERNS,
    enabled: true,
  };

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => resolve(items));
    });
  }

  function setSettings(partial) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(partial, () => resolve());
    });
  }

  function onChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      callback(changes);
    });
  }

  const api = { getSettings, setSettings, onChanged, DEFAULTS };
  if (typeof window !== 'undefined') window.GReadStorage = api;
  if (typeof self !== 'undefined') self.GReadStorage = api;
})();
