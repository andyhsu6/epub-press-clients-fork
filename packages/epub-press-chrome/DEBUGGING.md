# Debugging

If you run into a bug while using EpubPressX, here is how to collect useful debug information.

## Popup errors

1. Open EpubPressX and right-click on the popup.
2. Select `Inspect`. This opens a Chrome Inspector window for the popup.
3. Look at the `Console` tab for errors.
4. The `Network` tab shows requests made by the popup (image downloads, pagination fetches).

## Service worker errors

EpubPressX generates books locally in the popup, so the MV3 service worker is
a stub and usually has nothing to report. If you suspect worker issues:

1. Open `chrome://extensions` and enable `Developer Mode`.
2. Find `EpubPressX` and click `service worker` (or `Inspect views`).
3. Look at the `Console` tab.

## Known debugging tips

- **Download stuck / no file appears**: the popup generates the book and
  downloads it as a `data:` URL so the download survives popup close. If a
  download is stuck, check the popup console for `Download failed: ...` messages.
- **Ad text still in export**: verify the page's ad blocks are links pointing to
  a different domain than the article (external-domain link blocks and bare URLs
  are stripped; inline text without a URL is kept).
- **Extraction returns nothing**: article-extractor requires ~200 chars of text;
  very short pages may extract to empty. The test suite uses a longer fixture for
  this reason.
