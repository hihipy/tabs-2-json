/**
 * Shared jsdom harness for the extractor and pipeline suites.
 *
 * pageExtractor runs in a page and leans on innerText, which plain Node does not
 * have and jsdom does not implement. Both suites need the same approximation, so
 * it lives here.
 *
 * The naive substitution innerText -> textContent is wrong for real pages: it
 * includes the text of <script> and <style> elements, which a real browser's
 * innerText never returns because those elements are not rendered. On a
 * script-heavy page that inflates rawText with code and can hide a low-signal
 * shell. This harness instead reads textContent from a clone with the
 * non-rendered elements removed, which matches the one property of innerText the
 * extractor depends on. It still does not reproduce innerText's whitespace or
 * visibility rules, so the suites assert structural behaviour, not exact spacing.
 */

import { JSDOM } from "jsdom";
import { pageExtractor } from "../src/lib/extractor.js";

/** Elements whose text a real browser's innerText never returns. */
const NON_RENDERED = "script, style, noscript, template";

/** Default low-signal floor, matching the popup's LOW_SIGNAL_MIN_CHARS. */
export const LOW_SIGNAL_MIN_CHARS = 200;

/**
 * Run the real pageExtractor against an HTML string under jsdom, with a faithful
 * innerText approximation installed.
 * @param {string} html
 * @param {string} [url] The document URL, used for location.href and canonical.
 * @param {number} [minChars] Low-signal floor to pass to the extractor.
 * @returns {Object} The pageExtractor result.
 */
export function extract(html, url, minChars = LOW_SIGNAL_MIN_CHARS) {
    const dom = new JSDOM(html, url ? { url } : undefined);
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
        get() {
            const clone = this.cloneNode(true);
            clone.querySelectorAll(NON_RENDERED).forEach((el) => el.remove());
            return clone.textContent;
        },
        configurable: true
    });
    const previous = global.document;
    global.document = dom.window.document;
    try {
        return pageExtractor(minChars);
    } finally {
        global.document = previous;
        dom.window.close();
    }
}
