# Privacy Policy

**Extension:** GitHub Generated-File Auto-Viewer
**Last updated:** 2026-05-07
**Maintainer contact:** amitai.frey@lema.ai

This extension is open source. The behavior described below can be verified by reading the source code in this repository.

## Summary

The extension does not collect, transmit, sell, or share any personal information. It runs entirely in your browser, talks only to `https://github.com`, and stores a small amount of configuration data locally.

## What data the extension stores

The extension uses `chrome.storage.sync` to persist exactly two pieces of data, both of which you provide:

1. **Glob patterns** — the list of file-path patterns you configure on the options page (e.g. `**/*.pb.go`, `package-lock.json`).
2. **Enabled flag** — a boolean reflecting the on/off toggle in the popup.

This data is stored in your browser and, if you are signed in to Chrome with sync enabled, synchronized across your own Chrome profiles by Google. The maintainer never receives, reads, or has access to this data. You can clear it at any time by removing the extension at `chrome://extensions`.

## What data the extension transmits

When you load a GitHub pull-request review page (`/pull/N/files` or `/pull/N/changes`), the extension:

1. Reads file paths from the PR's diff DOM in the current tab.
2. For each file path that matches one of your configured glob patterns, sends an authenticated `POST` request to GitHub's own `https://github.com/<owner>/<repo>/pull/<N>/file_review` endpoint with the body `{path, viewed: "viewed"}`. This is the same endpoint GitHub uses when you click the native "Viewed" checkbox.

Requests are sent only to `https://github.com`, only on PR review pages, and only on your behalf using your existing GitHub session cookie. The extension makes no requests to any other domain. There is no telemetry, analytics, error reporting, or remote configuration.

## What data the extension does not collect

The extension does **not** collect, transmit, or have access to:

- Personally identifiable information (name, email, address, phone, etc.)
- Health, financial, authentication, or location data
- Browsing history, web activity outside of GitHub PR pages, or content from other websites
- The contents of any file in any pull request
- Your GitHub credentials, tokens, or account metadata

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | To persist your glob patterns and on/off toggle locally. |
| `activeTab` | So the popup's "Run on this page" button can act on the current tab. |
| `scripting` | To inject the extension's own content scripts on a GitHub PR tab when you click "Run on this page" on a tab that pre-existed the extension's install or update. Injection is limited to the active tab and only loads files bundled with the extension. |
| Host permission `https://github.com/*` | The extension's sole function is to operate on GitHub pull-request review pages. |

The extension does not have, and does not request, access to any other website.

## Third parties

The extension does not include any third-party SDK, analytics, advertising, error-reporting, or content-delivery service. The only network destination is `github.com`, and the only data sent is the per-file `file_review` payload described above, which GitHub's own UI also sends when you mark a file as Viewed.

## Children's privacy

The extension is a developer tool and is not directed at children under the age of 13. It does not knowingly collect any data from anyone.

## Changes to this policy

If this policy changes in a future version, the updated text will be committed to this repository and the "Last updated" date above will change. Material changes (e.g. introduction of a new network destination) will additionally be called out in the release notes.

## Contact

Questions, concerns, or requests:
- Email: amitai.frey@lema.ai
- GitHub Issues: open an issue in this repository.
