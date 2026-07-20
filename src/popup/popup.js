/**
 * Tabs2JSON popup controller.
 *
 * Lists the open tabs, lets the user select which to export, then reads the
 * text and metadata of the selected tabs and delivers the result as a JSON
 * download or clipboard copy. All work happens locally in the browser; the
 * extension makes no network requests.
 */

import { pageExtractor } from "../lib/extractor.js";
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

/**
 * Capture a single tab, applying the active settings to shape the output.
 * Never throws: capture failures are returned as records with ok set to false.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<Object>}
 */
async function captureTab(tab) {
    const capturedAt = new Date().toISOString();

    try {
        // Inject into every frame, not just the top document. Some sites, such as
        // applicant tracking systems and embedded document viewers, render the real
        // content inside a cross-origin iframe, leaving the top frame as a shell.
        // Host permission for the frame's origin is required, which <all_urls>
        // provides. A frame the script cannot run in is simply absent from results.
        const injections = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: pageExtractor,
            args: [LOW_SIGNAL_MIN_CHARS]
        });

        const frames = injections.filter((f) => f && f.result);
        if (frames.length === 0) {
            throw new Error("No readable frame in this tab.");
        }

        // Tab identity (title, URL, canonical) comes from the top frame, which owns
        // the address-bar URL.
        const topFrame = frames.find((f) => f.frameId === 0) || frames[0];
        // Body content comes from whichever frame yielded the most text, so an
        // iframe-embedded article or posting wins over the surrounding shell.
        // Ad and chat-widget frames carry little text and lose this comparison.
        const bodyFrame = frames.reduce(
            (best, f) =>
                (f.result.rawText || "").length > (best.result.rawText || "").length ? f : best,
            frames[0]
        );

        const meta = topFrame.result;
        const body = bodyFrame.result;
        const fromSubFrame = bodyFrame !== topFrame;

        const structured = body.structured || [];
        const videoOnly = isVideoOnly(structured);

        // A video-only page carries little useful body text; the VideoObject in the
        // structured data is the real content. Flag it so a consumer can skip the
        // body and lean on the structured data instead.
        let lowSignal = Boolean(body.lowSignal) || videoOnly;

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

        // When the body came from a sub-frame, record which frame, so a consumer
        // can see the text is not from the tab's own URL.
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
            // Force the Save As dialog on every platform so the user can rename
            // or relocate the file. Without this, Windows saves straight to the
            // downloads folder with no prompt, regardless of the timestamped name.
            saveAs: true
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