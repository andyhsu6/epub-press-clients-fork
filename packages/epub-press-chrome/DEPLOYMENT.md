# Deployment

`epub-press-chrome` is a browser extension for Chrome/Firefox.

To deploy a new version:

-   Make sure dependencies are up to date.
-   `npm install`
-   Update the version in the `manifest.json` (following [semver](https://semver.org/)).
-   Make sure the manifest `homepage_url` points to the correct host.
-   `npm run package` (builds and writes the artifacts below into `releases/`).
-   Upload the `.zip` to the [Chrome store](https://chrome.google.com/webstore/developer/dashboard).
-   Upload the `.zip` to the [Firefox store](https://addons.mozilla.org/en-US/developers/addons).
-   Update the CHANGELOG.
-   Create a new release on Github with the `.crx` file.

## Packaging for local sharing

```sh
npm run package
```

This runs `build-prod`, then writes to `releases/`:

-   `epubpressx-chrome-<version>.zip` — unzip and load via "Load unpacked" (recommended).
-   `epubpressx-chrome-<version>.crx` — signed sideload; only installable directly on Linux/ChromeOS or via enterprise policy (stable Chrome/Brave/Edge on macOS/Windows block off-store CRX).
-   `epubpressx-chrome.key.pem` — signing key. **Keep it private and keep it version-to-version**; deleting it changes the extension ID.

Chromium detection covers Chrome/Brave/Edge/Chromium (macOS/Linux/Windows); override with `CHROME_BIN=/path/to/browser`. If no browser is found, the `.crx` step is skipped and only the `.zip` is produced.

## Reloading the unpacked extension after a rebuild

The unpacked extension is served from the built bundle `app/build/popup.js`. After **any** rebuild (`npm run build`, `npm start`, or `npm run build-prod`), the browser must be made to re-read that file explicitly:

1. Open the extensions page (`chrome://extensions`), click **Remove** on the EpubPressX entry.
2. Click **Load unpacked** again and select the `app/` folder.

A plain **Reload** on the existing entry has been observed *not* to pick up the rebuilt bundle; until the extension is removed and added again, the browser can keep serving the previous build.

### Confirming which build is actually live

-   The extensions page shows which entry is loaded; make sure it points at the `app/` folder of this checkout and that only one EpubPressX entry exists.
-   Open the popup, then its DevTools **Console** and **Network** tabs. A build with pagination issues requests for the next page of a multi-page article; if the Network tab stays empty while exporting such an article, the browser is running a build without pagination.

### Known unproven report

The 2026-09-15 report that an export "only exports the first page" remains **UNPROVEN**: the bundle that was loaded at the time did contain the pagination code, and a full end-to-end run merged every page. Dropping the stale `releases/app.crx` (which held a pre-pagination build) and documenting the reload discipline above are insurance against a stale build, not a confirmed fix for that report.

