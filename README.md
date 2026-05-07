# GitHub Generated-File Auto-Viewer

A Chrome extension that automatically marks generated files as **Viewed** on GitHub pull-request review pages, based on user-defined glob patterns.

Stop scrolling past `*.gen.go`, `package-lock.json`, and `**/generated/**`. Configure once, focus on the diff that matters.

## Features

- **Glob-based matching** — `**/*.pb.go`, `package-lock.json`, `**/generated/**`, `!**/keep-me.ts`, etc.
- **Auto-marks on page load**, plus a **Run on this page** button in the popup for one-shot use.
- **Works with both** GitHub's new PR review experience (`/changes`) and the legacy `/files` page.
- **Sensible defaults** — lockfiles, `*.gen.*`, `*_pb.*`, `*.min.*`, `dist/**`, `build/**`, more.
- **Patterns sync across devices** via Chrome Sync.
- **Zero third-party network calls** — only `https://github.com`. No telemetry.

## Install

### From Chrome Web Store
*(coming soon — link will go here once published)*

### From source (load unpacked)

1. Clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this directory.
5. Open a GitHub PR's Files-changed tab — files matching the default patterns will be auto-marked Viewed.

To update: `git pull`, then click the circular-arrow reload icon on the extension's card at `chrome://extensions`.

## Configure

Click the extension's icon in the toolbar → **Edit patterns…** to open the options page. One glob per line:

```
# any file ending in .pb.go, anywhere in tree
**/*.pb.go

# everything inside a generated/ folder
**/generated/**

# but not these specific files
!**/generated/keep-me.ts

# exact name, anywhere
package-lock.json
```

Supported syntax (minimatch subset):

| Syntax | Meaning |
| --- | --- |
| `**` | any depth |
| `*` | any chars except `/` |
| `?` | single char |
| `{a,b}` | alternation |
| `[abc]` | character class |
| `!` at line start | negate |
| `#` at line start | comment |

There's a "Test a path" input on the options page that shows live which pattern would match a given file path.

## Privacy

The extension stores your glob patterns and on/off toggle in `chrome.storage.sync` (your browser only). The only network requests it makes are to `https://github.com/<owner>/<repo>/pull/<N>/file_review` — the same endpoint GitHub uses when you click the native "Viewed" checkbox.

See [PRIVACY.md](./PRIVACY.md) for the full policy.

## How it works (short version)

1. A small page-world script (`src/page-interceptor.js`) wraps `window.fetch` so the extension can capture the per-session `x-fetch-nonce` and `x-github-client-version` that GitHub's React client sends with verified-fetch requests.
2. The content script scans the diff list for file containers (legacy `div.file[data-tagsearch-path]` *and* the new React `[class*="PullRequestDiffsList-module__diffEntry"]`), reads each file's path, matches against your patterns, and posts `{path, viewed: "viewed"}` to `/pull/N/file_review`.
3. A `MutationObserver` catches new entries as the React app mounts them while you scroll, so virtualized rows are handled too.

## Development

No build step. Plain HTML/CSS/JS. Edit files in `src/`, reload at `chrome://extensions`.

## License

MIT — see [LICENSE](./LICENSE).
