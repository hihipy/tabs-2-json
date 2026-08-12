# Privacy Policy

`Tabs2JSON` is a browser extension that exports the text and metadata of tabs you select into a [JSON](https://www.json.org/) file. This policy explains what the extension does and does not do with your data.

---

## What the extension accesses

When you select one or more tabs and choose to export, the extension reads the following from each selected tab:

- The visible text content of the page, via [`innerText`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText)
- Page metadata such as title, URL, [canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), language, author, description, and publication date when present
- [Structured data](https://json-ld.org/) (JSON-LD) that the page itself embeds
- The heading outline of the page

To build the list you pick from, the extension also reads which window each tab is in and which tab group it belongs to, along with that group's name and color. This is used only to arrange the list on screen. None of it is written to the exported file.

The extension reads the content of a page only when you have selected that tab and triggered an export. It never reads page content in the background. Opening the popup does read the title and URL of your open tabs, which is what the list you pick from is made of.

---

## What the extension does with your data

All processing happens locally on your device, inside your browser. The extracted content is written to a JSON file that you download, or copied to your [clipboard](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), at your request.

While a download is in progress the file is held in memory by a hidden [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen), which exists only so the save can finish after the popup closes. It is discarded as soon as the file is written.

The extension does not:

- Send the content of your tabs, or any other information about you, to any server
- Contact any analytics, telemetry, or tracking service
- Include advertising of any kind
- Keep a copy of your tabs' content once the export is finished

One clarification about network activity. The popup shows each tab's favicon, which your browser fetches from that site the same way the tab strip does. That request carries nothing about you beyond the fact that a favicon was requested, and it is the only network activity the extension causes. Nothing the extension reads from your pages is ever transmitted.

---

## The file you download

The export contains the full visible text of every tab you selected, so treat the file as being as sensitive as those pages. If you export a page you are signed in to, that page's content is in the file, in plain text, wherever you saved it.

The file saves to your downloads folder under a timestamped name based on your local clock. To be asked for a name and folder each time instead, turn on "ask where to save each file before downloading" in your browser's download settings.

---

## Settings storage

Your preferences (theme and export settings) are stored locally using the [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage) API. This data stays on your device and is never transmitted. Removing the extension clears it.

---

## Permissions

Each permission requested in [`manifest.json`](https://developer.chrome.com/docs/extensions/reference/manifest) is used only for the purpose listed:

- [`tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs): to list your open tabs and read their titles and URLs so you can choose which to export
- [`tabGroups`](https://developer.chrome.com/docs/extensions/reference/api/tabGroups): to read the name and color of your tab groups, so the list can show your tabs grouped the way your browser does
- [`scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting): to read the page content of the tabs you select
- [`downloads`](https://developer.chrome.com/docs/extensions/reference/api/downloads): to save the JSON file to your downloads folder
- [`offscreen`](https://developer.chrome.com/docs/extensions/reference/api/offscreen): to hold the generated file in memory while it downloads, so closing the popup does not cancel the save
- [`storage`](https://developer.chrome.com/docs/extensions/reference/api/storage): to remember your settings locally
- host access: required so the scripting permission can read content from the pages you choose

---

## Restricted and blocked pages

The extension cannot read browser internal pages (for example `chrome://` or `brave://` pages), `file://` pages, or the [Chrome Web Store](https://chromewebstore.google.com/). You can also add your own list of blocked domains in the settings, which the extension will never read.

---

## Contact

Questions about this policy can be raised as an issue on the [project repository](https://github.com/hihipy/tabs-2-json/issues).
