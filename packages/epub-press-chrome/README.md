# epub-press-chrome

> A browser extension for creating ebooks from your tabs (EpubPressX custom line).

EpubPressX: generates EPUB/TXT books **locally** in the popup via `generater.js` (article extraction + JSZip), no server needed.

## Features

- EPUB and TXT export
- Multi-tab merge, automatic pagination, auto TOC
- Ad/recommendation link and bare URL stripping
- Bilingual UI (en / zh_CN), Manifest V3, Firefox compatible

## Development

```bash
# Development
npm start            # build + watch
npm run build        # single build

# Production
npm run build-prod   # production build
```

## Test

```bash
npm test                             # dev-server + open browser at localhost:5001/index.html
node run-browser-tests.mjs           # headless browser tests (uses Brave/Chrome via CDP)
node --test node-strip-test.mjs      # Node-native tests (linkedom shim)
node --test download-fix-test.mjs    # download helper tests
```

## Load unpacked

1. Run `npm run build-prod`.
2. Go to `chrome://extensions`, enable Developer Mode.
3. Click "Load unpacked" and select the `app/` folder.

## Packaging

See [DEPLOYMENT.md](DEPLOYMENT.md).

## Architecture (EpubPressX)

- `scripts/popup.js` — popup UI logic; collects tab HTML and calls `generateEpub`/`generateTxt`, then downloads via `chrome.downloads`.
- `scripts/generater.js` — core pipeline: `@extractus/article-extractor` extraction, auto-pagination, ad-link/URL stripping, TOC, EPUB assembly (JSZip).
- `scripts/browser.js` — thin `chrome.*` wrapper.
- `scripts/ui.js` — popup DOM manipulation.
- `scripts/service.js` — MV3 service worker stub (local generation needs no background worker).
