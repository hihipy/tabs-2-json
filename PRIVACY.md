# Privacy Policy

`Tabs2JSON` is a browser extension that exports the text and metadata of tabs you select into a [JSON](https://www.json.org/) file. This policy explains what the extension does and does not do with your data.

---

## What the extension accesses

When you select one or more tabs and choose to export, the extension reads the following from each selected tab:

- The visible text content of the page, via [`innerText`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText)
- Page metadata such as title, URL, [canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), language, author, description, and publication date when present
- [Structured data](https://json-ld.org/) (JSON-LD) that the page itself embeds
- The heading outline of the page

The extension only reads a tab when you explicitly select it and trigger an export. It does not read tabs in the background.

---

## What the extension does with your data

All processing happens locally on your device, inside your browser. The extracted content is written to a JSON file that you download, or copied to your [clipboard](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), at your request.

The extension does not:

- Send your data to any server
- Contact any external service or network endpoint
- Include analytics, tracking, or telemetry of any kind
- Store the content of your tabs

---

## Settings storage

Your preferences (theme and export settings) are stored locally using the [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage) API. This data stays on your device and is never transmitted. Removing the extension clears it.

---

## Permissions

Each permission requested in [`manifest.json`](https://developer.chrome.com/docs/extensions/reference/manifest) is used only for the purpose listed:

- [`tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs): to list your open tabs and read their titles and URLs so you can choose which to export
- [`scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting): to read the page content of the tabs you select
- [`downloads`](https://developer.chrome.com/docs/extensions/reference/api/downloads): to save the JSON file to your downloads folder
- [`storage`](https://developer.chrome.com/docs/extensions/reference/api/storage): to remember your settings locally
- host access: required so the scripting permission can read content from the pages you choose

---

## Restricted and blocked pages

The extension cannot read browser internal pages (for example `chrome://` or `brave://` pages) or the [Chrome Web Store](https://chromewebstore.google.com/). You can also add your own list of blocked domains in the settings, which the extension will never read.

---

## Contact

Questions about this policy can be raised as an issue on the [project repository](https://github.com/hihipy/tabs-2-json/issues).
