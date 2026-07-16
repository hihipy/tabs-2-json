/**
 * Tabs2JSON popup controller.
 *
 * Lists the open tabs, lets the user select which to export, then reads the
 * text and metadata of the selected tabs and delivers the result as a JSON
 * download or clipboard copy. All work happens locally in the browser; the
 * extension makes no network requests.
 */

import {
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    isScriptable,
    isBlocked,
    outputUrl,
    isVideoOnly,
    cleanText,
    prune,
    sanitizeStructured,
    timestampName
} from "../lib/extract.js";

// ---------------------------------------------------------------------------
// Constants and module state
// ---------------------------------------------------------------------------

/** Storage key for the user's theme preference. */
const THEME_KEY = "theme";

/** Character cap applied to the text of video-only pages when trimming is on. */
const VIDEO_SNIPPET_CHARS = 300;

/**
 * Minimum length of extracted text below which a capture is treated as low
 * signal. This is a conservative near-empty check: it flags pages that yielded
 * almost no text (for example a client-rendered shell that never populated),
 * and deliberately does not try to judge full-but-noisy pages, which cannot be
 * detected reliably without site-specific logic.
 */
const LOW_SIGNAL_MIN_CHARS = 200;

const tabListEl = document.getElementById("tab-list");
const selectAllEl = document.getElementById("select-all");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const refreshBtn = document.getElementById("refresh");
const settingsBtn = document.getElementById("open-settings");
const themeSelect = document.getElementById("theme");

/** Active settings for this popup session. */
let settings = { ...DEFAULT_SETTINGS };

/** The most recent tab list, retained so the UI can re-render on changes. */
let allTabs = [];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Load settings from local storage, falling back to defaults for any
 * missing keys.
 * @returns {Promise<void>}
 */
async function loadSettings() {
    try {
        const stored = await chrome.storage.local.get(SETTINGS_KEY);
        settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    } catch (err) {
        settings = { ...DEFAULT_SETTINGS };
    }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Resolve a theme preference to a concrete "light" or "dark" value.
 * @param {string} pref One of "auto", "light", or "dark".
 * @returns {string} "light" or "dark".
 */
function resolveTheme(pref) {
    if (pref === "light" || pref === "dark") {
        return pref;
    }
    return darkQuery.matches ? "dark" : "light";
}

/**
 * Apply a theme preference to the document root.
 * @param {string} pref One of "auto", "light", or "dark".
 */
function applyTheme(pref) {
    document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

// Follow the system theme live while the popup is open and set to Auto.
darkQuery.addEventListener("change", () => {
    if (themeSelect.value === "auto") {
        applyTheme("auto");
    }
});

themeSelect.addEventListener("change", () => {
    const pref = themeSelect.value;
    applyTheme(pref);
    chrome.storage.local.set({ [THEME_KEY]: pref });
});

/**
 * Initialise the theme control from stored preference, applying a sensible
 * default first to avoid a flash of the wrong theme.
 * @returns {Promise<void>}
 */
async function initTheme() {
    applyTheme("auto");
    try {
        const stored = await chrome.storage.local.get(THEME_KEY);
        const pref = stored[THEME_KEY] || "auto";
        themeSelect.value = pref;
        applyTheme(pref);
    } catch (err) {
        themeSelect.value = "auto";
    }
}

// ---------------------------------------------------------------------------
// Tab list rendering
// ---------------------------------------------------------------------------

/**
 * Determine why a tab cannot be captured, if at all.
 * @param {chrome.tabs.Tab} tab
 * @returns {("restricted"|"blocked"|null)}
 */
function captureBlockReason(tab) {
    if (!isScriptable(tab.url)) {
        return "restricted";
    }
    if (isBlocked(tab.url, settings.blockedDomains)) {
        return "blocked";
    }
    return null;
}

/**
 * Return the enabled tab checkboxes currently in the list.
 * @returns {HTMLInputElement[]}
 */
function checkboxes() {
    return Array.from(
        tabListEl.querySelectorAll("input[type=checkbox]:not(:disabled)")
    );
}

/**
 * Refresh the selection count, the Select All state, and the enabled state of
 * the action buttons.
 */
function updateCount() {
    const boxes = checkboxes();
    const selected = boxes.filter((b) => b.checked).length;
    countEl.textContent = selected + " of " + boxes.length + " selected";

    selectAllEl.checked = selected > 0 && selected === boxes.length;
    selectAllEl.indeterminate = selected > 0 && selected < boxes.length;

    const none = selected === 0;
    downloadBtn.disabled = none;
    copyBtn.disabled = none;
}

/**
 * Render the tab list. Capturable tabs are checked by default; restricted and
 * blocked tabs are shown disabled with an explanatory tag.
 * @param {chrome.tabs.Tab[]} tabs
 */
function renderTabs(tabs) {
    tabListEl.innerHTML = "";

    tabs.forEach((tab) => {
        const reason = captureBlockReason(tab);
        const capturable = reason === null;

        const row = document.createElement("li");
        row.className = "tab-row" + (capturable ? "" : " restricted");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = capturable;
        checkbox.disabled = !capturable;
        checkbox.dataset.tabId = String(tab.id);
        checkbox.addEventListener("change", updateCount);

        const favicon = document.createElement("img");
        favicon.className = "tab-favicon";
        favicon.alt = "";
        if (tab.favIconUrl) {
            favicon.src = tab.favIconUrl;
        }

        const textWrap = document.createElement("span");
        textWrap.className = "tab-text";

        const title = document.createElement("div");
        title.className = "tab-title";
        title.textContent = tab.title || tab.url || "Untitled tab";

        const sub = document.createElement("div");
        if (capturable) {
            sub.className = "tab-url";
            sub.textContent = tab.url;
        } else {
            sub.className = "tab-tag";
            sub.textContent =
                reason === "blocked"
                    ? "Blocked by your settings"
                    : "Restricted page, cannot read";
        }

        textWrap.append(title, sub);

        const label = document.createElement("label");
        label.style.display = "contents";
        label.append(checkbox, favicon, textWrap);
        row.append(label);
        tabListEl.append(row);
    });

    updateCount();
}

selectAllEl.addEventListener("change", () => {
    checkboxes().forEach((box) => {
        box.checked = selectAllEl.checked;
    });
    updateCount();
});

/**
 * Return the tab ids of the currently selected, capturable tabs.
 * @returns {number[]}
 */
function selectedTabIds() {
    return checkboxes()
        .filter((box) => box.checked)
        .map((box) => Number(box.dataset.tabId));
}

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

/**
 * Runs in the context of the target page. Reads visible text and metadata in a
 * page-type-agnostic way, then returns a plain data object. This function must
 * stay self-contained: it cannot reference anything from the popup scope.
 * @param {number} lowSignalMinChars Below this text length, mark low signal.
 * @returns {Object}
 */
function pageExtractor(lowSignalMinChars) {
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

/**
 * Capture a single tab, applying the active settings to shape the output.
 * Never throws: capture failures are returned as records with ok set to false.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<Object>}
 */
async function captureTab(tab) {
    const capturedAt = new Date().toISOString();

    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: pageExtractor,
            args: [LOW_SIGNAL_MIN_CHARS]
        });

        const result = injection.result || {};
        const structured = result.structured || [];
        const videoOnly = isVideoOnly(structured);

        // A video-only page carries little useful body text; the VideoObject in
        // the structured data is the real content. Flag it so a consumer can
        // skip the body and lean on the structured data instead.
        let lowSignal = Boolean(result.lowSignal) || videoOnly;

        let text = cleanText(result.rawText);
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

        const record = {
            id: tab.id,
            title: tab.title || result.documentTitle || "",
            url: outputUrl(tab.url || "", settings.stripUrlParams),
            canonical_url: outputUrl(result.canonical, settings.stripUrlParams),
            site_name: result.siteName,
            description: result.description,
            language: result.lang,
            author: result.author,
            published_at: result.published,
            content_source: result.contentSource,
            content_type: videoOnly ? "video" : null,
            captured_at: capturedAt,
            ok: true
        };

        if (settings.includeHeadings) {
            record.headings = result.headings || [];
        }
        if (settings.includeStructuredData) {
            record.structured_data = structured.map(sanitizeStructured);
        }
        if (settings.includeText) {
            record.text = text;
            record.word_count = text ? text.split(/\s+/).filter(Boolean).length : 0;
            if (textTruncated) {
                record.text_truncated = true;
            }
        }

        // Present only when true; absence means the extraction looked normal.
        if (lowSignal) {
            record.low_signal = true;
        }

        return prune(record);
    } catch (err) {
        return {
            id: tab.id,
            title: tab.title || "",
            url: outputUrl(tab.url || "", settings.stripUrlParams),
            captured_at: capturedAt,
            ok: false,
            error: err && err.message ? err.message : String(err)
        };
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Capture all selected tabs and assemble the export payload as a JSON string.
 * @returns {Promise<{json: string, count: number, failed: number}>}
 */
async function buildExport() {
    const ids = selectedTabIds();
    const tabs = allTabs.filter((tab) => ids.includes(tab.id));
    setStatus(
        "Reading " + tabs.length + " tab" + (tabs.length === 1 ? "" : "s") + "..."
    );

    const results = await Promise.all(tabs.map(captureTab));
    const failed = results.filter((r) => !r.ok).length;

    const payload = {
        exported_at: new Date().toISOString(),
        tab_count: results.length,
        tabs: results
    };

    const indent = settings.prettyJson ? 2 : 0;
    return {
        json: JSON.stringify(payload, null, indent),
        count: results.length,
        failed: failed
    };
}

/**
 * Set the status line text and error styling.
 * @param {string} message
 * @param {boolean} [isError]
 */
function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("error", Boolean(isError));
}

downloadBtn.addEventListener("click", async () => {
    try {
        const { json, count, failed } = await buildExport();
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        await chrome.downloads.download({
            url: url,
            filename: timestampName(),
            saveAs: false
        });
        // Release the object URL once the download has had time to start.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus(
            "Downloaded " +
            count +
            " tab" +
            (count === 1 ? "" : "s") +
            (failed ? " (" + failed + " could not be read)" : "") +
            "."
        );
    } catch (err) {
        setStatus(
            "Download failed: " + (err && err.message ? err.message : err),
            true
        );
    }
});

copyBtn.addEventListener("click", async () => {
    try {
        const { json, count, failed } = await buildExport();
        await navigator.clipboard.writeText(json);
        setStatus(
            "Copied " +
            count +
            " tab" +
            (count === 1 ? "" : "s") +
            " to clipboard" +
            (failed ? " (" + failed + " could not be read)" : "") +
            "."
        );
    } catch (err) {
        setStatus("Copy failed: " + (err && err.message ? err.message : err), true);
    }
});

// ---------------------------------------------------------------------------
// Toolbar actions
// ---------------------------------------------------------------------------

refreshBtn.addEventListener("click", () => {
    refreshBtn.classList.add("spinning");
    setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
    loadTabs();
});

settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

/**
 * Query all open tabs, retain them, and render the list.
 * @returns {Promise<void>}
 */
async function loadTabs() {
    try {
        allTabs = await chrome.tabs.query({});
        renderTabs(allTabs);
        const anyCapturable = allTabs.some((tab) => captureBlockReason(tab) === null);
        setStatus(anyCapturable ? "" : "No readable tabs are open.");
    } catch (err) {
        setStatus(
            "Could not load tabs: " + (err && err.message ? err.message : err),
            true
        );
    }
}

// Keep the popup in sync when settings or theme change from the options page.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
        return;
    }
    if (changes[SETTINGS_KEY]) {
        settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
        renderTabs(allTabs);
    }
    if (changes[THEME_KEY]) {
        const pref = changes[THEME_KEY].newValue || "auto";
        themeSelect.value = pref;
        applyTheme(pref);
    }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialise the popup: load settings and theme, then the tab list.
 * @returns {Promise<void>}
 */
async function init() {
    await loadSettings();
    await initTheme();
    await loadTabs();
}

init();