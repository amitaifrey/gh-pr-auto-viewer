# Chrome Web Store listing copy

## Listing name
Generated-File Auto-Viewer for GitHub PRs

## Category
**Developer Tools** (primary). Optional secondary: *Workflow & Planning Tools*.

## Short description (≤ 132 chars)
Auto-marks generated files as Viewed on GitHub PRs. Configure glob patterns for lockfiles, codegen, snapshots, and more.

## Detailed description

Stop scrolling past noise. This extension watches your GitHub pull-request **Files changed** tab and automatically ticks the **Viewed** checkbox on files whose paths match your configured glob patterns — lockfiles, generated protobufs, codegen output, build artifacts, snapshots, anything you don't want to read line-by-line.

### Features
- 🎯 **Glob-based matching** — `**/*.pb.go`, `package-lock.json`, `**/generated/**`, `!**/keep-me.ts`, etc.
- 🔁 **Auto-marks on page load**, plus a **Run on this page** button in the popup for one-shot use.
- 🆕 **Works with GitHub's new PR review experience** (`/changes` URL) *and* the legacy `/files` page.
- 🧱 **Sensible defaults** — lockfiles, `*.gen.*`, `*_pb.*`, `*.min.js`, `dist/**`, `build/**`, and more, ready to tweak.
- ☁️ **Patterns sync across devices** via Chrome Sync.
- 🔒 **Zero network calls** to anywhere except github.com — no telemetry, no analytics, no remote config.

### Why?
Reviewers waste minutes per PR clicking through files they already know they won't read carefully. This extension makes that automatic, so you can focus on the diff that actually matters.

### How it works
The extension reads the file path of each diff entry, matches it against your patterns (using minimatch-style globs), and POSTs to GitHub's own `file_review` endpoint to persist the "Viewed" state — exactly what clicking the checkbox does, just done for you. Patterns can be edited from the options page, and a popup toggle lets you pause it temporarily.

### Privacy
- All settings are stored in your browser via `chrome.storage.sync`.
- The extension only ever talks to `https://github.com` — no third-party services.
- Open source: review the code or contribute on GitHub.

## Permissions justification (paste into the form)

- **storage** — to save your glob patterns and the on/off toggle.
- **activeTab** — so the popup's "Run on this page" button can act on the current tab.
- **scripting** — to inject the content script on PR tabs that were already open before the extension was installed or updated.
- **Host permission `https://github.com/*`** — the extension's only purpose is to operate on GitHub PR pages.

## Single-purpose statement
This extension does one thing: automatically mark generated files as Viewed on GitHub pull-request review pages, based on user-defined glob patterns.

## Tags / keywords
github, pull request, code review, viewed, generated, glob, lockfile, productivity, developer tools

## Support contact
(your email — required by Chrome Web Store)

## Privacy policy URL
(host a one-page policy on GitHub Pages or in the repo; the store requires a URL)

## Promotional images checklist
- [x] **Store icon** — `icons/128.png` (128×128, already in the zip)
- [ ] **Screenshot 1** — `screenshots/01-options.png` (1280×800)
- [ ] **Screenshot 2** — `screenshots/02-popup.png` (1280×800)
- [ ] **Screenshot 3** — `screenshots/03-pr-marked.png` (1280×800) ← grab a real PR after install
- [ ] **Marquee promo tile** — `marquee-1400x560.png`
- [ ] **Small promo tile (optional)** — `small-promo-440x280.png`
