# Tabs2JSON

[![Link Check](https://github.com/hihipy/tabs-2-json/actions/workflows/links.yml/badge.svg)](https://github.com/hihipy/tabs-2-json/actions/workflows/links.yml)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

**Built with**

[![Chrome](https://img.shields.io/badge/Chrome-4285F4?style=flat&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![JSON](https://img.shields.io/badge/JSON-000000?style=flat&logo=json&logoColor=white)](https://www.json.org/)

**Turn your open tabs into clean JSON.**

`Tabs2JSON` is a browser extension that reads the text and metadata of the tabs you select and exports it as structured [JSON](https://www.json.org/), built for feeding page content to a large language model. It works across page types by relying on how [HTML](https://developer.mozilla.org/en-US/docs/Web/HTML) organizes content rather than assuming any particular site structure.

---

## Why this exists

Copying a job description, an article, or a set of research pages into an LLM one tab at a time is slow, and pasted browser text arrives cluttered with navigation and footer boilerplate. `Tabs2JSON` grabs the readable content from every tab you pick in one click, strips most of the chrome, preserves any [Schema.org](https://schema.org/) structured data the page already ships, and hands you a single JSON document an LLM can consume end to end.

---

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/bljpjkglinfdphfopjdfoookglelobhj), which works in any [Chromium](https://www.chromium.org/Home/) browser that supports [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3): [Chrome](https://www.google.com/chrome/), [Brave](https://brave.com/), [Edge](https://www.microsoft.com/edge), [Opera](https://www.opera.com/), and others.

To run the source directly instead:

1. Open [`chrome://extensions`](https://developer.chrome.com/docs/extensions/get-started) (or `brave://extensions` in [Brave](https://brave.com/)).
2. Turn on Developer mode.
3. Click Load unpacked and select this folder.
4. Pin the extension and click its icon to open the popup.

---

## Use

Open the popup, tick the tabs you want, and choose Download JSON or Copy to Clipboard. Readable tabs are selected by default. Browser internal pages and any domains you block are shown disabled and cannot be read. The gear opens Settings; the refresh button re-reads your open tabs.

---

## Output format

The export is a single JSON object. Consumers should gate on `ok` first, then read the optional fields, treating any absent optional key as "not provided".

Top level:

- `exported_at`: [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html) timestamp of the export.
- `tab_count`: number of tab records.
- `tabs`: array of tab records.

Every tab record always has:

- `id`: the browser tab id. Stable identifier for mapping results back to a tab, even when URL parameters are stripped.
- `title`: the tab title.
- `url`: the page URL. Query parameters are removed when Strip Query Parameters is on.
- `content_source`: where the text came from, one of `main`, `article`, an element tag, `heuristic`, or `body`.
- `captured_at`: [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html) timestamp of the capture.
- `ok`: `true` on success, `false` on capture failure.

On success, present when the page provides them and the matching setting is on:

- `canonical_url`, `site_name`, `description`, `language`, `author`, `published_at`: page metadata, each omitted when absent. Drawn from standard [meta tags](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta), [Open Graph](https://ogp.me/) properties, and the [canonical link](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls).
- `content_frame_url`: present only when the body text came from a cross-origin sub-frame rather than the tab's own page, such as an embedded applicant tracking system or document viewer. It is the URL of that frame, so a consumer can see the text is not from `url`. Absent on ordinary single-frame pages.
- `headings`: array of `{ level, text }`, when Include Headings Outline is on.
- `structured_data`: array of [JSON-LD](https://json-ld.org/) objects the page embedded, when Include Structured Data is on. Any string value that contains HTML markup is reduced to its text, so embedded markup and inline CSS do not leak into the output; values without markup are unchanged.
- `text`: the cleaned visible text, when Include Page Text is on.
- `word_count`: word count of `text`. Counted by whitespace, so languages written without spaces (Chinese, Japanese, Thai) read low; the `text` itself is unaffected.
- `content_type`: set to `video` when the page is video-only, otherwise absent.

Boolean flags are present only when true. Their absence means false:

- `text_truncated`: the text was shortened by the video trim or the character cap.
- `low_signal`: the extracted `text` is unreliable, set in two cases. Either the text came back nearly empty (under 200 characters), which usually means a client-rendered page never populated; or the page is video-only, whose body carries little useful text and whose real content sits in `structured_data`. It is a high-precision flag, not a noise detector: a page with substantial but low-quality text (for example a search results page) will not carry it, so absence does not guarantee the text is clean.

On failure, the record has `id`, `title`, `url`, `captured_at`, `ok` set to `false`, and:

- `error`: a short message describing the failure. No text or metadata fields are present.

### Consumer notes

- Gate on `ok` before reading anything else.
- Treat `low_signal` and a `content_type` of `video` as signals to distrust `text` and prefer `structured_data`.
- `id` is the reliable join key. `url` is not unique once parameters are stripped.
- When `content_frame_url` is present, the text came from an embedded frame, not from `url`.

### Example output

A two-tab export, trimmed:

```json
{
  "exported_at": "2026-07-16T05:06:39.530Z",
  "tab_count": 2,
  "tabs": [
    {
      "id": 1490142341,
      "title": "JSON - Wikipedia",
      "url": "https://en.wikipedia.org/wiki/JSON",
      "canonical_url": "https://en.wikipedia.org/wiki/JSON",
      "language": "en",
      "content_source": "main",
      "captured_at": "2026-07-16T05:06:39.493Z",
      "ok": true,
      "headings": [
        { "level": 1, "text": "JSON" },
        { "level": 2, "text": "Syntax" }
      ],
      "structured_data": [
        { "@context": "https://schema.org", "@type": "Article", "headline": "JSON" }
      ],
      "text": "JSON (JavaScript Object Notation) is an open standard file format ...",
      "word_count": 1863
    },
    {
      "id": 1490142248,
      "title": "What is JSON? (Explained in 5 minutes) - YouTube",
      "url": "https://www.youtube.com/watch",
      "content_source": "ytd-watch-flexy",
      "content_type": "video",
      "captured_at": "2026-07-16T05:06:39.501Z",
      "ok": true,
      "text": "What is JSON? (Explained in 5 minutes) ...",
      "word_count": 112,
      "low_signal": true
    }
  ]
}
```

The first record is a normal article capture. The second is a video-only page, flagged `content_type: video` and `low_signal: true` so a consumer knows to lean on `structured_data` over `text`.

---

## How extraction works

The extension reads each page in a way that does not depend on the site being modern or well-built.

1. **Content root.** It looks for a semantic [`<main>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/main), then [`<article>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article), then an element with [`role="main"`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/main_role). If none exist, it scores content blocks by text length and link density to find the real content, and falls back to the [`<body>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/body) as a last resort. This keeps it working on older table-layout pages as well as current ones.
2. **Text.** It reads [`innerText`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText) from the chosen root, so visible block structure survives. It then peels a leading navigation or aside block when that block's text is an exact prefix of the body, which removes in-page menu bars without touching prose, and normalizes whitespace.
3. **Structured data.** It parses every [JSON-LD](https://json-ld.org/) block on the page, whatever the [Schema.org](https://schema.org/) type, and reduces any string value that carries HTML markup to its text. Some sites embed large HTML fragments inside JSON-LD strings; this keeps that markup out of the output while leaving ordinary values untouched.
4. **Metadata.** It reads standard [meta tags](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta), the [canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), and the [document language](https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/lang).

Some sites render the real content inside a cross-origin iframe, such as embedded applicant tracking systems or document viewers, leaving the top frame as a shell. To handle that, the extension injects into every frame it has access to, skips known junk frames (captcha, ad, analytics, consent, and chat widgets) by URL, and keeps the remaining frame with the most words. Ranking by words rather than characters keeps a machine-generated blob, like a reCAPTCHA widget's payload, from beating the real page. When the winning frame is not the tab's own page, its URL is reported as `content_frame_url`.

The read runs through the [`chrome.scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting) API only on the tabs you select, and only when you trigger an export.

---

## Settings

The options page is built with the [`options_ui`](https://developer.chrome.com/docs/extensions/reference/api/action) pattern and stores preferences locally via the [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage) API.

- Content: include or exclude page text, [structured data](https://json-ld.org/), and the headings outline.
- Video Pages: trim text on video-only pages to a short snippet.
- Limits: cap the characters of text kept per tab.
- Privacy: strip query parameters from URLs, and block domains the extension will never read.
- Output: pretty-print or compact JSON.

Settings save automatically and apply on the next export.

---

## Development

There is no build step and the extension has no runtime dependencies; it runs the source directly. The popup and options pages share their pure logic through `src/lib/extract.js`, and the injected page extractor lives in `src/lib/extractor.js`.

Tests come in four suites. The unit suite covers the shared pure logic and runs on [Node](https://nodejs.org/) with no dependencies:

    node test/unit.mjs

The other three run the real code against fixture HTML under [jsdom](https://github.com/jsdom/jsdom), the one dev dependency, so they need an install first:

    npm install
    npm test

The extractor suite runs the injected page extractor and checks which content root it picks and whether leading nav is peeled. The pipeline suite feeds real extractor output from several frames into the frame picker, covering the cross-origin iframe and junk-frame cases. The holistic suite runs the whole flow, from rendered frames through the record assembly, and asserts the full output record. All four use Node's built-in [`node:test`](https://nodejs.org/api/test.html) runner, so `npm test` runs them in one pass, aggregates the results, and prints a full diff on any failure.

jsdom is used only for tests; it is never shipped with the extension. Two coverage notes. jsdom has no `innerText`, so the suites approximate it by keeping only rendered, visible text: they drop the non-rendered elements (`script`, `style`, `noscript`, `template`) and any node hidden with `display:none`, `visibility:hidden`, or the `hidden` attribute. They do not drop `aria-hidden`, which changes the accessibility tree but not rendering, so a real browser's `innerText` still returns that text. jsdom has no layout engine, so it resolves visibility from inline styles and simple stylesheet rules but not from anything geometric (off-screen positioning, zero-size clipping), and it does not reproduce innerText's block-boundary whitespace; the suites assert structural behaviour rather than exact spacing, and a real-browser export stays the backstop for layout-dependent visibility. And the checks that reduce HTML with `DOMParser` (`stripHtml` and the markup path of `sanitizeStructured`) are skipped in the unit suite under plain Node and run under jsdom in the holistic suite.

---

## Accessibility

- Type is set in [Atkinson Hyperlegible Next](https://www.brailleinstitute.org/freefont/), a typeface from the [Braille Institute](https://www.brailleinstitute.org/) designed for legibility.
- Light and dark themes both meet [WCAG](https://www.w3.org/WAI/standards-guidelines/wcag/) AA contrast, and most pairings meet AAA.
- The palette relies on brightness rather than hue, and error states carry a symbol and weight in addition to color, so meaning survives for [color vision deficiency](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html).
- The theme follows your system setting by default via [`prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme), with explicit light and dark overrides.

---

## Privacy

All work happens locally in the browser. The extension makes no network requests and includes no analytics or tracking. See [`PRIVACY.md`](PRIVACY.md) for detail.

---

## Permissions

Declared in [`manifest.json`](https://developer.chrome.com/docs/extensions/reference/manifest) under [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3):

| Permission                                                   | Why                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| [`tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs) | List open tabs and read their titles and URLs         |
| [`scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting) | Read page content of the tabs you select              |
| [`downloads`](https://developer.chrome.com/docs/extensions/reference/api/downloads) | Save the JSON file to your downloads folder           |
| [`storage`](https://developer.chrome.com/docs/extensions/reference/api/storage) | Remember your settings locally                        |
| host access                                                  | Required so `scripting` can read the pages you choose |

---

## Versioning

This project uses [Calendar Versioning (CalVer)](https://calver.org/) in the format `YYYY.M.PATCH`. The first two parts are the year and month of the release; the last is the patch number for additional releases within that month.

---

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

You are free to:

- Use, share, and adapt this work
- Use it at your job

Under these terms:

- **Attribution.** Credit the original author.
- **NonCommercial.** No selling or commercial products.
- **ShareAlike.** Derivatives must use the same license.
