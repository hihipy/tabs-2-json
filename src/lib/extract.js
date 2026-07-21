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
// Frame selection
// ---------------------------------------------------------------------------

/**
 * Hostname suffixes that never carry a page's main content: captcha widgets, ad
 * and analytics frames, consent managers, and chat widgets. A frame served from
 * one of these is excluded from the body-frame contest. Matched as a suffix, so
 * an exact host or any subdomain qualifies.
 */
const JUNK_FRAME_HOSTS = [
    // Captcha and bot-check widgets
    "recaptcha.net",
    "hcaptcha.com",
    "challenges.cloudflare.com",
    "arkoselabs.com",
    "funcaptcha.com",
    // Ads and ad exchanges
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagmanager.com",
    "googletagservices.com",
    "google-analytics.com",
    "adnxs.com",
    "adsrvr.org",
    "amazon-adsystem.com",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "casalemedia.com",
    "scorecardresearch.com",
    "moatads.com",
    "adform.net",
    "smartadserver.com",
    "3lift.com",
    "bidswitch.net",
    // Social embeds and tracking pixels
    "connect.facebook.net",
    "platform.twitter.com",
    "syndication.twitter.com",
    "platform.linkedin.com",
    "ads.linkedin.com",
    // Consent and cookie managers
    "onetrust.com",
    "cookielaw.org",
    "trustarc.com",
    "consensu.org",
    "quantcast.com",
    "quantserve.com",
    "cookiebot.com",
    "usercentrics.eu",
    "usercentrics.com",
    "privacy-mgmt.com",
    // Chat, support, and feedback widgets
    "intercom.io",
    "intercom.com",
    "intercomcdn.com",
    "drift.com",
    "zendesk.com",
    "zdassets.com",
    "livechatinc.com",
    "tawk.to",
    "crisp.chat",
    "hotjar.com",
    "walkme.com"
];

/**
 * Host plus path-prefix rules for junk that lives on an otherwise-content
 * domain, where the host alone cannot be blocked. reCAPTCHA and Google's ad
 * frames sit under google.com and gstatic.com, which also serve real content,
 * so only the specific paths are excluded.
 */
const JUNK_FRAME_PATHS = [
    { host: "google.com", path: "/recaptcha" },
    { host: "google.com", path: "/pagead" },
    { host: "gstatic.com", path: "/recaptcha" },
    { host: "facebook.com", path: "/plugins" },
    { host: "facebook.com", path: "/tr" }
];

/**
 * Return true when a host equals a suffix or is a subdomain of it.
 * @param {string} host
 * @param {string} suffix
 * @returns {boolean}
 */
function hostHasSuffix(host, suffix) {
    return host === suffix || host.endsWith("." + suffix);
}

/**
 * Return true when a frame URL belongs to a known non-content frame: a captcha,
 * ad, analytics, consent, or chat widget. Such a frame is never the page's real
 * content, so it must not win the body-frame contest even when its payload is
 * large (reCAPTCHA's anchor frame, for one, carries a very long base64 blob).
 * @param {string} url
 * @returns {boolean}
 */
export function isJunkFrame(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (err) {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (JUNK_FRAME_HOSTS.some((suffix) => hostHasSuffix(host, suffix))) {
        return true;
    }
    const path = parsed.pathname.toLowerCase();
    return JUNK_FRAME_PATHS.some(
        (rule) => hostHasSuffix(host, rule.host) && path.startsWith(rule.path)
    );
}

/**
 * Count whitespace-delimited words in a string.
 *
 * This is the measure used to rank frames and to report a capture's word count.
 * Word count, not character length, is what separates real content from a
 * machine-generated blob: a base64 payload is enormous in bytes but is a single
 * whitespace-free token, so it scores near zero here.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
    if (!text) {
        return 0;
    }
    return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Choose the frame whose text is the page's main content.
 *
 * Junk frames (captcha, ads, analytics, consent, chat) are dropped by URL first,
 * so their payloads cannot win. Among the rest, the frame with the most words
 * wins, which lets an iframe-embedded article or job posting beat the shell that
 * wraps it while starving any large blob that holds no prose. The top frame is
 * always kept as a candidate and is the seed, so ties favour the tab's own URL
 * and a page whose content is in its own top document still resolves.
 * @param {Array<{frameId:number, result:Object}>} frames Injection results, each
 *   with a truthy result carrying rawText and frameUrl.
 * @param {{frameId:number, result:Object}} topFrame The frameId 0 result.
 * @returns {{frameId:number, result:Object}} The chosen body frame.
 */
export function selectBodyFrame(frames, topFrame) {
    const pool = frames.filter(
        (f) => f === topFrame || !isJunkFrame(f.result && f.result.frameUrl)
    );
    return pool.reduce((best, f) => {
        const words = wordCount(f.result && f.result.rawText);
        const bestWords = wordCount(best.result && best.result.rawText);
        return words > bestWords ? f : best;
    }, topFrame);
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

/** Character cap applied to the text of video-only pages when trimming is on. */
export const VIDEO_SNIPPET_CHARS = 300;

/**
 * Assemble the output record for one captured tab from its injected frame
 * results and the active settings.
 *
 * This is the whole post-injection contract: pick the body frame, take tab
 * identity from the top frame, fall back to the body frame for optional
 * metadata, shape the text (video snippet trim, then the overall cap), attach
 * headings, sanitised structured data, and text per the settings, and record a
 * content_frame_url only when the body came from a sub-frame. Pruning drops keys
 * the page did not provide. It reads nothing from the DOM or a chrome API, so it
 * runs and is tested outside the browser; captureTab handles injection and the
 * failure record around it.
 *
 * @param {{id:number, title:string, url:string}} tab Tab identity fields.
 * @param {Array<{frameId:number, result:Object}>} frames Injection results, each
 *   with a truthy result. Must be non-empty.
 * @param {Object} settings Active export settings.
 * @param {string} capturedAt ISO timestamp for this capture.
 * @returns {Object} The pruned record.
 */
export function buildRecord(tab, frames, settings, capturedAt) {
    // Tab identity (title, URL, canonical) comes from the top frame, which owns
    // the address-bar URL. Body content comes from the frame the picker selects.
    const topFrame = frames.find((f) => f.frameId === 0) || frames[0];
    const bodyFrame = selectBodyFrame(frames, topFrame);

    const meta = topFrame.result;
    const body = bodyFrame.result;
    const fromSubFrame = bodyFrame !== topFrame;

    const structured = body.structured || [];
    const videoOnly = isVideoOnly(structured);
    const lowSignal = Boolean(body.lowSignal) || videoOnly;

    let text = cleanText(body.rawText);
    let textTruncated = false;

    // Video-only pages carry little useful body text, so trim to a snippet and
    // rely on the VideoObject in the structured data instead.
    if (settings.trimVideoText && videoOnly && text.length > VIDEO_SNIPPET_CHARS) {
        text = text.slice(0, VIDEO_SNIPPET_CHARS).trim();
        textTruncated = true;
    }

    // Apply the optional overall character cap.
    if (settings.maxTextChars > 0 && text.length > settings.maxTextChars) {
        text = text.slice(0, settings.maxTextChars).trim();
        textTruncated = true;
    }

    // Optional metadata prefers the top frame and falls back to the content
    // frame, which for an embedded page often carries the real values.
    const record = {
        id: tab.id,
        title: tab.title || meta.documentTitle || body.documentTitle || "",
        url: outputUrl(tab.url || "", settings.stripUrlParams),
        canonical_url: outputUrl(meta.canonical || body.canonical, settings.stripUrlParams),
        site_name: meta.siteName || body.siteName,
        description: meta.description || body.description,
        language: meta.lang || body.lang,
        author: meta.author || body.author,
        published_at: meta.published || body.published,
        content_source: body.contentSource,
        content_type: videoOnly ? "video" : null,
        captured_at: capturedAt,
        ok: true
    };

    // When the body came from a sub-frame, record which frame, so a consumer can
    // see the text is not from the tab's own URL.
    if (fromSubFrame && body.frameUrl) {
        record.content_frame_url = outputUrl(body.frameUrl, settings.stripUrlParams);
    }

    if (settings.includeHeadings) {
        record.headings = body.headings || [];
    }
    if (settings.includeStructuredData) {
        record.structured_data = structured.map(sanitizeStructured);
    }
    if (settings.includeText) {
        record.text = text;
        record.word_count = wordCount(text);
        if (textTruncated) {
            record.text_truncated = true;
        }
    }

    // Present only when true; absence means the extraction looked normal.
    if (lowSignal) {
        record.low_signal = true;
    }

    return prune(record);
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
