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

