/**
 * The page extractor, run in the context of the target page.
 *
 * This is imported by popup.js and passed to chrome.scripting.executeScript,
 * which serialises the function source and injects it into the page. Because it
 * is injected, it MUST stay self-contained: it may reference only the page's
 * document, its own argument, and its own inline helpers, never anything from
 * the importing module's scope. Moving it here does not change injection, since
 * executeScript serialises the function's own source either way.
 *
 * test/extractor.test.mjs imports this function directly and runs it under jsdom
 * against fixture HTML, with innerText polyfilled to textContent (jsdom does not
 * implement innerText). That covers content-root selection and the leading
 * chrome peel; it approximates innerText's whitespace and visibility semantics
 * rather than reproducing them exactly.
 *
 * @param {number} lowSignalMinChars Below this text length, mark low signal.
 * @returns {Object}
 */
export function pageExtractor(lowSignalMinChars) {
    const attr = (selector, name) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(name) : null;
    };

    const meta = (keys) => {
        for (const key of keys) {
            const el = document.querySelector(
                'meta[name="' + key + '"], meta[property="' + key + '"]'
            );
            if (el && el.getAttribute("content")) {
                return el.getAttribute("content");
            }
        }
        return null;
    };

    // Collect any JSON-LD blocks verbatim, deduped, without interpreting them.
    const seen = new Set();
    const structured = [];
    document
        .querySelectorAll('script[type="application/ld+json"]')
        .forEach((script) => {
            const raw = (script.textContent || "").trim();
            if (!raw || seen.has(raw)) {
                return;
            }
            seen.add(raw);
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    structured.push(...parsed);
                } else {
                    structured.push(parsed);
                }
            } catch (err) {
                // Ignore malformed JSON-LD.
            }
        });

    // Choose the content root: semantic tags first, then a density heuristic for
    // pages with no semantic structure, then the body as a last resort. This
    // keeps extraction working across both modern and older HTML.
    let root =
        document.querySelector("main") ||
        document.querySelector("article") ||
        document.querySelector('[role="main"]');
    let source = root ? root.tagName.toLowerCase() : null;

    if (!root) {
        const bodyLength = document.body
            ? (document.body.innerText || "").length
            : 0;

        // Cheap first pass: shortlist blocks by textContent length, which does
        // not force layout. innerText (which does force layout) then runs only
        // on a small, bounded set of candidates instead of every block on the
        // page, which keeps deeply nested legacy pages from freezing the popup.
        const candidates = [];
        document
            .querySelectorAll("body div, body section, body td, body table")
            .forEach((el) => {
                const length = (el.textContent || "").length;
                if (length >= 200) {
                    candidates.push({ el: el, length: length });
                }
            });
        candidates.sort((a, b) => b.length - a.length);

        let best = null;
        let bestScore = 0;

        candidates.slice(0, 50).forEach(({ el }) => {
            const text = el.innerText || "";
            if (text.length < 200) {
                return;
            }
            // Penalise link-heavy blocks so navigation menus lose to real content.
            let linkLength = 0;
            el.querySelectorAll("a").forEach((a) => {
                linkLength += (a.innerText || "").length;
            });
            const score = text.length - linkLength * 2;
            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        });

        if (best && bestScore > bodyLength * 0.4) {
            root = best;
            source = "heuristic";
        } else {
            root = document.body;
            source = "body";
        }
    }

    const headings = [];
    (root || document).querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
        const text = (h.innerText || "").trim();
        if (text) {
            headings.push({ level: Number(h.tagName[1]), text: text });
        }
    });

    let rootText = root ? root.innerText : "";

    // Peel leading navigation chrome. innerText of the content root can begin
    // with an in-page menu bar (namespace tabs, section nav) that lives inside
    // the root. A nav or aside block is removed only when its text is an exact
    // prefix of the body text, so this never touches prose mid-page and never
    // drops an article's own heading. Header widgets built from plain divs are
    // not landmarks and are left in place.
    const CHROME_SELECTOR = 'nav, aside, [role="navigation"], [role="complementary"]';
    const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();

    // Remove the first `normCount` normalised characters from the original
    // text, where normalisation trims leading whitespace and collapses each
    // internal run to one space. This maps a normalised prefix length back onto
    // the original so the surviving text keeps its own spacing.
    const sliceAfterNormalized = (original, normCount) => {
        let seen = 0;
        let inGap = true; // leading whitespace contributes nothing
        let i = 0;
        for (; i < original.length && seen < normCount; i++) {
            if (/\s/.test(original[i])) {
                if (!inGap) {
                    seen += 1; // one collapsed space per whitespace run
                    inGap = true;
                }
            } else {
                seen += 1;
                inGap = false;
            }
        }
        return original.slice(i);
    };

    const chromeTexts = Array.from((root || document).querySelectorAll(CHROME_SELECTOR))
        .map((el) => normalize(el.innerText))
        .filter((t) => t.length >= 8)
        .sort((a, b) => b.length - a.length);

    let peeled = true;
    while (peeled) {
        peeled = false;
        const normBody = normalize(rootText);
        for (const chromeText of chromeTexts) {
            if (chromeText && normBody.startsWith(chromeText)) {
                rootText = sliceAfterNormalized(rootText, chromeText.length).replace(/^\s+/, "");
                peeled = true;
                break;
            }
        }
    }

    // Near-empty check: a page that yielded almost no text is low signal. This is
    // a high-precision flag, not an attempt to judge full-but-noisy pages.
    const lowSignal = rootText.trim().length < lowSignalMinChars;

    return {
        documentTitle: document.title,
        lang: document.documentElement.getAttribute("lang") || null,
        canonical: attr('link[rel="canonical"]', "href"),
        siteName: meta(["og:site_name"]),
        description: meta(["description", "og:description", "twitter:description"]),
        author: meta(["author", "article:author"]),
        published: meta(["article:published_time", "datePublished", "date"]),
        contentSource: source,
        headings: headings.slice(0, 60),
        structured: structured,
        rawText: rootText,
        lowSignal: lowSignal
    };
}
