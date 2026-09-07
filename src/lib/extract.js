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
    prettyJson: true,
    defaultSelection: "window",
    hideUnreadable: false
};

/** Accepted values for the defaultSelection setting. */
export const SELECTION_SCOPES = ["window", "all", "none"];

/**
 * Coerce a stored defaultSelection value to one the popup can act on.
 *
 * Storage is writable by anything with the extension's key, and a value carried
 * over from a future or hand-edited settings object must not leave the list in a
 * state with no window expanded. Anything unrecognised falls back to the default.
 * @param {*} value
 * @returns {string} One of SELECTION_SCOPES.
 */
export function normalizeSelectionScope(value) {
    return SELECTION_SCOPES.includes(value) ? value : "window";
}

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
/**
 * Words a frame must carry, on top of clearing the low-signal floor, before it
 * counts as a page in its own right.
 *
 * The low-signal floor is 200 characters, which a header and a nav bar can clear
 * without the page saying anything. This is the second bar: roughly a short
 * paragraph. Any real article or posting is far above it, and any shell that
 * exists only to host an embed is far below.
 */
export const OWN_CONTENT_MIN_WORDS = 120;

/**
 * Whether a frame is a page in its own right rather than a host for an embed.
 * @param {Object} result A pageExtractor result.
 * @returns {boolean}
 */
export function hasOwnContent(result) {
    if (!result || result.lowSignal) {
        return false;
    }
    return wordCount(result.rawText) >= OWN_CONTENT_MIN_WORDS;
}

export function selectBodyFrame(frames, topFrame) {
    // The tab's own page wins outright when it carries real content, whatever a
    // sub-frame holds. Ranking every frame by word count cannot tell a job
    // description from the application form embedded beside it, because the form
    // legitimately has more words: an EEO survey, a veteran-status explanation,
    // and a disability questionnaire run longer than the posting they attach to.
    // Word count only decides which frame is the page when the page itself has
    // nothing to say.
    if (hasOwnContent(topFrame && topFrame.result)) {
        return topFrame;
    }

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

    // The tab title is what the browser shows on the tab strip. For a single-page
    // careers site it is the router's title and is the same on every posting, so
    // the page's own heading is preferred where the two disagree. The tab title is
    // kept alongside whenever it was overridden, so nothing is discarded.
    const tabTitle = tab.title || meta.documentTitle || body.documentTitle || "";
    const heading = primaryHeading(body.headings);
    const headingWins = preferPageHeading(tabTitle, heading);

    // Optional metadata prefers the top frame and falls back to the content
    // frame, which for an embedded page often carries the real values.
    const record = {
        id: tab.id,
        title: headingWins ? heading : tabTitle,
        tab_title: headingWins ? tabTitle : null,
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
// Capture orchestration
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. If the timeout wins, the returned promise
 * rejects with the given message; the original promise is left to settle on its
 * own. The timer is always cleared so it cannot outlive the race.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise}
 */
export function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read a page, preferring every frame but falling back to the top frame when the
 * all-frames read is slow or fails. This keeps a slow embedded frame (a map, an
 * ad, an analytics frame) from stalling the read: after subframeTimeoutMs the
 * top frame is read instead, so the page's own content still comes back. Only the
 * top-frame read, bounded by captureTimeoutMs, is allowed to fail the tab.
 *
 * Both reads are supplied as functions so this is testable without a browser: in
 * the extension they run chrome.scripting.executeScript, in tests they are fakes.
 * @param {() => Promise<Array>} readAllFrames
 * @param {() => Promise<Array>} readTopFrame
 * @param {number} subframeTimeoutMs
 * @param {number} captureTimeoutMs
 * @param {string} timeoutMessage Message when the top-frame read also times out.
 * @returns {Promise<Array>}
 */
export function readWithFallback(
    readAllFrames,
    readTopFrame,
    subframeTimeoutMs,
    captureTimeoutMs,
    timeoutMessage
) {
    return withTimeout(readAllFrames(), subframeTimeoutMs, "subframe-timeout").catch(() =>
        withTimeout(readTopFrame(), captureTimeoutMs, timeoutMessage)
    );
}

/**
 * Run captureOne over every item in parallel, reporting progress as each
 * completes and preserving input order in the results. captureOne is expected not
 * to reject (capture failures come back as records), so no rejection is caught.
 * @param {Array} items
 * @param {(item: *) => Promise<*>} captureOne
 * @param {(completed: number, total: number) => void} [onProgress]
 * @returns {Promise<Array>}
 */
export function captureAll(items, captureOne, onProgress) {
    const total = items.length;
    let completed = 0;
    return Promise.all(
        items.map((item) =>
            Promise.resolve(captureOne(item)).then((result) => {
                completed += 1;
                if (onProgress) {
                    onProgress(completed, total);
                }
                return result;
            })
        )
    );
}

/**
 * Describe capture failures for the status line: how many failed and, of those,
 * how many were timeouts. Empty string when nothing failed.
 * @param {number} failed
 * @param {number} timedOut
 * @returns {string}
 */
export function failureNote(failed, timedOut) {
    if (!failed) {
        return "";
    }
    const parts = [];
    if (timedOut) {
        parts.push(timedOut + " timed out");
    }
    const other = failed - timedOut;
    if (other) {
        parts.push(other + " could not be read");
    }
    return " " + parts.join(", ") + ".";
}

/**
 * Wrap an async task so that while one call is in flight, further calls are
 * ignored and return undefined. Used to stop a second export from starting while
 * one is still running, which otherwise queues duplicate downloads when a slow or
 * blocked Save As dialog makes the first look stuck. The lock is released whether
 * the task resolves or rejects, so a failure does not wedge the button.
 * @param {(...args: any[]) => Promise<any>} task
 * @returns {(...args: any[]) => Promise<any>}
 */
export function guardConcurrent(task) {
    let running = false;
    return async function guarded(...args) {
        if (running) {
            return undefined;
        }
        running = true;
        try {
            return await task(...args);
        } finally {
            running = false;
        }
    };
}

/**
 * Whether the popup should close itself after a download. Closes only on a fully
 * clean save (at least one tab written, nothing failed), so that when a tab
 * failed or timed out the popup stays open and its note remains readable. Copy
 * never closes: a download is a "done" action, a copy often is not.
 * @param {number} count Tabs written.
 * @param {number} failed Tabs that failed (timeouts included).
 * @returns {boolean}
 */
export function shouldCloseAfterDownload(count, failed) {
    return count > 0 && failed === 0;
}

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
 * Build the timestamped download filename from local system time, for example
 * "tabs2json-2026-07-16T01-06-39.json". Local rather than UTC so the name matches
 * the clock the file was saved by, which is what makes a folder of exports sortable
 * and recognisable at a glance. The timestamps inside the file stay UTC, where an
 * unambiguous instant matters more than a familiar one.
 * @returns {string}
 */
export function timestampName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");

    const stamp =
        now.getFullYear() +
        "-" + pad(now.getMonth() + 1) +
        "-" + pad(now.getDate()) +
        "T" + pad(now.getHours()) +
        "-" + pad(now.getMinutes()) +
        "-" + pad(now.getSeconds());

    return "tabs2json-" + stamp + ".json";
}

// ---------------------------------------------------------------------------
// Page title
// ---------------------------------------------------------------------------

/**
 * The heading that names the page, or an empty string when there is not one.
 *
 * A page whose content root carries exactly one heading at its shallowest level
 * is using that heading to say what it is about. Several headings at that level
 * means they are section labels, and the shallowest one is only the first
 * section, not the subject: an application form headed "Apply for this job",
 * "Voluntary Self-Identification", and "Voluntary Self-Identification of
 * Disability" is not a page about applying for this job.
 * @param {Array<Object>} headings
 * @returns {string}
 */
export function primaryHeading(headings) {
    if (!Array.isArray(headings) || headings.length === 0) {
        return "";
    }

    const levels = headings
        .filter((h) => h && typeof h.level === "number")
        .map((h) => h.level);
    if (levels.length === 0) {
        return "";
    }

    const shallowest = Math.min(...levels);
    const atTop = headings.filter((h) => h && h.level === shallowest);

    return atTop.length === 1 ? (atTop[0].text || "").trim() : "";
}

/**
 * Headings that label a section rather than name a page.
 *
 * An applicant tracking system often heads the posting body with one of these and
 * puts the job title in the document title instead, which inverts the situation
 * this rule exists for. Falling back to the tab title is always safe here, so the
 * list can be generous.
 */
const SECTION_LABEL_HEADINGS = new Set([
    "description",
    "job description",
    "full job description",
    "overview",
    "job overview",
    "summary",
    "job summary",
    "position summary",
    "about",
    "about us",
    "about the role",
    "about this role",
    "the role",
    "details",
    "job details",
    "responsibilities",
    "requirements",
    "qualifications",
    "apply",
    "apply now",
    "apply for this job",
    "careers",
    "main content",
    "content"
]);

/**
 * Whether a heading labels a section instead of naming the page.
 *
 * Two tests. A known section label, and a heading of one word: a page that names
 * itself almost always takes more than one word to do it, while "Description",
 * "Overview", and "Careers" are the shape a section label takes. A one-word
 * heading that genuinely is the page's subject usually appears inside the tab
 * title as well, which the containment check already handles.
 * @param {string} heading
 * @returns {boolean}
 */
function isSectionLabel(heading) {
    const text = (heading || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) {
        return true;
    }
    if (SECTION_LABEL_HEADINGS.has(text)) {
        return true;
    }
    return text.split(" ").length < 2;
}

/**
 * Whether the page's own heading names the page better than its tab title does.
 *
 * Single-page applications reuse one document title across every page they
 * route to, so a folder of exports from one careers site reads the same on every
 * record and identifies none of them. The heading is preferred only when the two
 * describe different things. Where either contains the other, the tab title is
 * already about the right subject and usually carries the site name too, so it
 * stays.
 * @param {string} tabTitle
 * @param {string} heading
 * @returns {boolean}
 */
export function preferPageHeading(tabTitle, heading) {
    const flatten = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();

    const title = flatten(tabTitle);
    const head = flatten(heading);

    if (!head || isSectionLabel(head)) {
        return false;
    }
    if (!title) {
        return true;
    }
    return !title.includes(head) && !head.includes(title);
}

// ---------------------------------------------------------------------------
// Window and group sections
// ---------------------------------------------------------------------------

/** The group id the browser reports for a tab that belongs to no group. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * Name an untitled tab group by its color, matching how the browser's own tab
 * strip identifies a group the user never named.
 * @param {string} color A chrome.tabGroups color name.
 * @returns {string}
 */
function colorGroupLabel(color) {
    const name = color || "grey";
    return name.charAt(0).toUpperCase() + name.slice(1) + " group";
}

/**
 * Arrange a flat tab list into one section per window, with tab groups nested
 * inside the window that holds them.
 *
 * A group belongs to exactly one window, so nesting it there matches the
 * browser's own model and avoids presenting groups as a second, competing way to
 * slice the same tabs. Within a window, tabs keep the order the query returned,
 * which is tab-strip order, and a group takes the position of its first tab so a
 * group does not jump to the top of a window it sits partway down.
 *
 * The current window sorts first and is labelled by relation rather than by
 * number, because the popup opens inside that window and "this window" is how
 * the user already thinks of it. Window and group ids are unique only within a
 * browser session, so nothing here may be persisted across restarts.
 *
 * Pure: it reads no browser API and returns plain data, so the arrangement is
 * testable without a browser.
 *
 * @param {Array<Object>} tabs Tabs as returned by chrome.tabs.query.
 * @param {Array<Object>} groups Groups as returned by chrome.tabGroups.query, or
 *   an empty array when the API is unavailable.
 * @param {number} currentWindowId The window the popup was opened from.
 * @returns {Array<Object>} One section per window, each carrying an ordered items
 *   array of group and tab entries.
 */
export function buildTabSections(tabs, groups, currentWindowId) {
    const groupsById = new Map();
    (groups || []).forEach((group) => {
        if (group && typeof group.id === "number") {
            groupsById.set(group.id, group);
        }
    });

    const queryOrder = [];
    const tabsByWindow = new Map();

    (tabs || []).forEach((tab) => {
        if (!tab || typeof tab.windowId !== "number") {
            return;
        }
        if (!tabsByWindow.has(tab.windowId)) {
            tabsByWindow.set(tab.windowId, []);
            queryOrder.push(tab.windowId);
        }
        tabsByWindow.get(tab.windowId).push(tab);
    });

    // The current window first, every other window in the order the query gave.
    const windowIds = queryOrder
        .filter((id) => id === currentWindowId)
        .concat(queryOrder.filter((id) => id !== currentWindowId));

    return windowIds.map((windowId, index) => {
        const windowTabs = tabsByWindow.get(windowId) || [];
        const items = [];
        const groupItems = new Map();

        windowTabs.forEach((tab) => {
            const groupId =
                typeof tab.groupId === "number" ? tab.groupId : TAB_GROUP_ID_NONE;

            if (groupId === TAB_GROUP_ID_NONE) {
                items.push({ kind: "tab", tab: tab });
                return;
            }

            let item = groupItems.get(groupId);
            if (!item) {
                const meta = groupsById.get(groupId);
                const color = (meta && meta.color) || "grey";
                item = {
                    kind: "group",
                    groupId: groupId,
                    title: (meta && meta.title) || colorGroupLabel(color),
                    color: color,
                    tabs: []
                };
                groupItems.set(groupId, item);
                items.push(item);
            }
            item.tabs.push(tab);
        });

        const activeTab = windowTabs.find((tab) => tab.active);

        return {
            windowId: windowId,
            isCurrent: windowId === currentWindowId,
            label: windowId === currentWindowId ? "This window" : "Window " + (index + 1),
            activeTitle: activeTab ? activeTab.title || "" : "",
            items: items
        };
    });
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
