/**
 * Shared pure logic for Tabs2JSON.
 *
 * These functions and constants are imported by both the popup and the options
 * page, and are covered directly by test/unit.mjs. Nothing here reads the DOM or
 * a chrome API at module load, so the module imports cleanly under Node.
 * stripHtml uses DOMParser at call time, which exists in the browser (and under
 * jsdom) but not in plain Node.
 *
 * Logic that must run inside the injected page extractor (the content-root
 * scoring, heading and metadata reads, the leading-chrome peel) is deliberately
 * not here: that function is serialised and injected into the page, so it cannot
 * import a module and keeps its helpers inline in popup.js.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storage key for the user's export settings. */
export const SETTINGS_KEY = "settings";

/** Default settings, merged over whatever is found in storage. */
export const DEFAULT_SETTINGS = {
    includeText: true,
    includeStructuredData: true,
    includeHeadings: true,
    trimVideoText: true,
    maxTextChars: 0, // 0 means no limit
    stripUrlParams: false,
    blockedDomains: [],
    prettyJson: true
};

/** Schema.org types that indicate a page carries real article-style prose. */
export const ARTICLE_TYPES = [
    "Article",
    "NewsArticle",
    "BlogPosting",
    "TechArticle",
    "Report",
    "ScholarlyArticle"
];

/** Matches an HTML tag, used to detect markup embedded in JSON-LD strings. */
const HTML_TAG = /<[a-z!/][^>]*>/i;

// ---------------------------------------------------------------------------
// URL and domain helpers
// ---------------------------------------------------------------------------

/**
 * Return true when a URL can be read by a content script.
 *
 * file: URLs are intentionally excluded. chrome.scripting cannot inject into
 * them unless the user has manually granted file access, which the manifest
 * cannot request, so a file tab would look capturable and then fail. Marking it
 * not scriptable renders it as a restricted row instead.
 * @param {string} url
 * @returns {boolean}
 */
export function isScriptable(url) {
    return /^https?:/i.test(url || "");
}

/**
 * Extract the lowercase hostname from a URL, or an empty string on failure.
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (err) {
        return "";
    }
}

/**
 * Return true when a URL's host matches one of the blocked domains, either
 * exactly or as a subdomain.
 * @param {string} url
 * @param {string[]} list
 * @returns {boolean}
 */
export function isBlocked(url, list) {
    const host = hostOf(url);
    if (!host) {
        return false;
    }
    return (list || []).some((domain) => host === domain || host.endsWith("." + domain));
}

/**
 * Apply the URL-parameter privacy setting to a URL, dropping the query string
 * and fragment when enabled. The per-tab id field preserves stable identity
 * even when parameters are stripped.
 * @param {string} url
 * @param {boolean} stripParams
 * @returns {string}
 */
export function outputUrl(url, stripParams) {
    if (!url || !stripParams) {
        return url;
    }
    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname;
    } catch (err) {
        return url;
    }
}

// ---------------------------------------------------------------------------
// Structured-data helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect every schema.org @type found in a JSON-LD node,
 * descending into arrays and @graph containers.
 * @param {*} node
 * @param {Set<string>} acc
 */
export function collectTypes(node, acc) {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((item) => collectTypes(item, acc));
        return;
    }
    if (node["@graph"]) {
        collectTypes(node["@graph"], acc);
    }
    const type = node["@type"];
    if (Array.isArray(type)) {
        type.forEach((t) => acc.add(String(t)));
    } else if (type) {
        acc.add(String(type));
    }
}

/**
 * Return the set of schema.org types present across all JSON-LD blocks.
 * @param {Array} structured
 * @returns {Set<string>}
 */
export function schemaTypes(structured) {
    const acc = new Set();
    (structured || []).forEach((node) => collectTypes(node, acc));
    return acc;
}

/**
 * Decide whether a page is video-only, meaning it carries a VideoObject but no
 * article-style content. Such pages have little useful body text.
 * @param {Array} structured
 * @returns {boolean}
 */
export function isVideoOnly(structured) {
    const types = schemaTypes(structured);
    const hasVideo = types.has("VideoObject");
    const hasArticle = ARTICLE_TYPES.some((t) => types.has(t));
    return hasVideo && !hasArticle;
}

// ---------------------------------------------------------------------------
// Text and payload helpers
// ---------------------------------------------------------------------------

/**
 * Normalise whitespace in extracted text: trim each line and collapse runs of
 * blank lines, without disturbing the block structure.
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
    return (text || "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Remove keys whose values are null, empty strings, or empty arrays, so the
 * output JSON carries only fields the page actually provided. Boolean false is
 * intentionally kept, so flags that should appear only when true are added
 * conditionally by the caller rather than relying on pruning.
 * @param {Object} obj
 * @returns {Object}
 */
export function prune(obj) {
    const out = {};
    Object.keys(obj).forEach((key) => {
        const value = obj[key];
        if (value == null) {
            return;
        }
        if (typeof value === "string" && value.trim() === "") {
            return;
        }
        if (Array.isArray(value) && value.length === 0) {
            return;
        }
        out[key] = value;
    });
    return out;
}

/**
 * Reduce an HTML string to its text content, decoding entities and collapsing
 * whitespace. Parsing through DOMParser as text/html does not execute scripts
 * and does not touch the live page. Call only on strings known to contain
 * markup.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Drop elements whose text is not content: style and script carry CSS and
    // JS, which survive a plain textContent read and would otherwise replace the
    // markup as noise.
    doc.querySelectorAll("script, style, noscript, template").forEach((el) => {
        el.remove();
    });
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

/**
 * Recursively sanitise a JSON-LD node: any string value carrying HTML markup is
 * replaced by its text. Some sites embed large HTML fragments inside JSON-LD
 * string fields (for example a job posting's description), which are pure noise
 * for a text consumer. Strings without markup are returned unchanged, so
 * ordinary values, URLs, and text that merely contains a bare "<" are left
 * alone.
 * @param {*} node
 * @returns {*}
 */
export function sanitizeStructured(node) {
    if (typeof node === "string") {
        return HTML_TAG.test(node) ? stripHtml(node) : node;
    }
    if (Array.isArray(node)) {
        return node.map(sanitizeStructured);
    }
    if (node && typeof node === "object") {
        const out = {};
        Object.keys(node).forEach((key) => {
            out[key] = sanitizeStructured(node[key]);
        });
        return out;
    }
    return node;
}

/**
 * Build the timestamped download filename, for example
 * "tabs2json-2026-07-16T05-06-39.json".
 * @returns {string}
 */
export function timestampName() {
    const iso = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return "tabs2json-" + iso + ".json";
}

// ---------------------------------------------------------------------------
// Options-form parsing
// ---------------------------------------------------------------------------

/**
 * Parse an integer from a string, clamping to a minimum.
 * @param {string} value
 * @param {number} min
 * @returns {number}
 */
export function clampInt(value, min) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < min) {
        return min;
    }
    return n;
}

/**
 * Parse a blocked-domains textarea into a clean, deduped list of hostnames.
 * Accepts newline or comma separators and tolerates pasted URLs.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseDomains(raw) {
    const parts = String(raw || "")
        .split(/[\n,]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    return Array.from(new Set(parts));
}
