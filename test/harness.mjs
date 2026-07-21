/**
 * Shared jsdom harness for the extractor, pipeline, and holistic suites.
 *
 * pageExtractor runs in a page and leans on innerText, which plain Node does not
 * have and jsdom does not implement. All three suites need the same
 * approximation, so it lives here.
 *
 * The naive substitution innerText -> textContent is wrong in two ways a real
 * browser is not. First, textContent returns the text of <script> and <style>
 * elements, which innerText never does because they are not rendered. Second,
 * textContent returns text hidden with display:none, visibility:hidden, or the
 * hidden attribute, which innerText also drops. Both would inflate rawText and
 * could hide a low-signal shell or defeat the leading-chrome peel. This harness
 * walks the element and keeps only rendered, visible text, skipping the
 * non-rendered tags and any node jsdom reports as hidden. It does not skip
 * aria-hidden, which changes the accessibility tree but not rendering, so a real
 * browser's innerText still returns that text. jsdom has no layout engine, so it
 * resolves display and visibility from inline styles and simple stylesheet rules
 * but not from anything that needs geometry (off-screen positioning, zero-size
 * clipping); the suites therefore assert structural behaviour, not exact
 * whitespace, and a real-browser export remains the backstop for visibility bugs
 * that depend on layout.
 */

import { JSDOM } from "jsdom";
import { pageExtractor } from "../src/lib/extractor.js";

/** Elements whose text a real browser's innerText never returns. */
const NON_RENDERED = new Set(["script", "style", "noscript", "template"]);

/** Default low-signal floor, matching the popup's LOW_SIGNAL_MIN_CHARS. */
export const LOW_SIGNAL_MIN_CHARS = 200;

/**
 * True when jsdom reports the element as not rendered or not visible, using only
 * the mechanisms that actually suppress innerText: the hidden attribute,
 * display:none, and visibility:hidden. aria-hidden is deliberately excluded, it
 * removes a node from the accessibility tree but does not affect rendering, so a
 * real browser's innerText still returns its text. Treating aria-hidden content
 * as noise, if that is wanted, belongs in the extractor and should be tested
 * against a faithful innerText, not folded into this approximation.
 */
function isHidden(el, win) {
    if (el.hidden) {
        return true;
    }
    const cs = win.getComputedStyle(el);
    return Boolean(cs) && (cs.display === "none" || cs.visibility === "hidden");
}

/**
 * Approximate innerText: the concatenated text of rendered, visible descendants.
 * Reproduces the two properties the extractor depends on (no script or style
 * text, no hidden text) but not innerText's block-boundary whitespace.
 */
function innerTextApprox(el) {
    const win = el.ownerDocument.defaultView;
    if (isHidden(el, win)) {
        return "";
    }
    let out = "";
    for (const node of el.childNodes) {
        if (node.nodeType === 3) {
            out += node.data;
        } else if (node.nodeType === 1) {
            if (NON_RENDERED.has(node.tagName.toLowerCase())) {
                continue;
            }
            if (isHidden(node, win)) {
                continue;
            }
            out += innerTextApprox(node);
        }
    }
    return out;
}

/**
 * Run the real pageExtractor against an HTML string under jsdom, with the
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
            return innerTextApprox(this);
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
