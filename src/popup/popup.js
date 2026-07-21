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
    timestampName,
    buildRecord,
    readWithFallback,
    captureAll,
    failureNote,
    guardConcurrent
} from "../lib/extract.js";

// ---------------------------------------------------------------------------
// Constants and module state
// ---------------------------------------------------------------------------

/** Storage key for the user's theme preference. */
const THEME_KEY = "theme";

/**
 * Minimum length of extracted text below which a capture is treated as low
 * signal. This is a conservative near-empty check: it flags pages that yielded
 * almost no text (for example a client-rendered shell that never populated),
 * and deliberately does not try to judge full-but-noisy pages, which cannot be
 * detected reliably without site-specific logic.
 */
const LOW_SIGNAL_MIN_CHARS = 200;

/**
 * How long to wait for the all-frames read before falling back to the top frame.
 * Injecting into every frame captures content embedded in a cross-origin iframe
 * (applicant tracking systems, document viewers), but it also waits on frames
 * that never matter and can be slow to settle, such as embedded maps, ad, and
 * analytics frames. When that wait exceeds this budget, the top frame alone is
 * read instead, which returns the page's own content quickly.
 */
const SUBFRAME_TIMEOUT_MS = 4000;

/**
 * Hard ceiling for the top-frame fallback read. A top-frame read resolves in
 * milliseconds; this exists so a genuinely unresponsive page becomes an error
 * record rather than stalling the export with no way out.
 */
const CAPTURE_TIMEOUT_MS = 15000;

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
 * Read a tab's frames, preferring all frames and falling back to the top frame
 * when sub-frames are slow. The read logic lives in readWithFallback so it is
 * tested without a browser; here it is wired to chrome.scripting.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<Array>} Injection results, one per frame that responded.
 */
function readFrames(tab) {
    const inject = (target) =>
        chrome.scripting.executeScript({
            target,
            func: pageExtractor,
            args: [LOW_SIGNAL_MIN_CHARS]
        });

    return readWithFallback(
        () => inject({ tabId: tab.id, allFrames: true }),
        () => inject({ tabId: tab.id, frameIds: [0] }),
        SUBFRAME_TIMEOUT_MS,
        CAPTURE_TIMEOUT_MS,
        "Timed out after " + Math.round(CAPTURE_TIMEOUT_MS / 1000) + " seconds reading this tab."
    );
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
        // readFrames bounds the wait on slow sub-frames and falls back to the top
        // frame, so an embedded map or ad frame cannot stall the read.
        const injections = await readFrames(tab);

        const frames = injections.filter((f) => f && f.result);
        if (frames.length === 0) {
            throw new Error("No readable frame in this tab.");
        }

        // Everything from frame selection to the finished record is pure and lives
        // in buildRecord, so it can be tested without a browser.
        return buildRecord(
            { id: tab.id, title: tab.title, url: tab.url },
            frames,
            settings,
            capturedAt
        );
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
 * @returns {Promise<{json: string, count: number, failed: number, timedOut: number}>}
 */
async function buildExport() {
    const ids = selectedTabIds();
    const tabs = allTabs.filter((tab) => ids.includes(tab.id));
    const total = tabs.length;
    const noun = total === 1 ? "tab" : "tabs";

    setStatus("Reading " + total + " " + noun + "...");

    // Reads run in parallel; captureAll reports each completion so the user sees
    // progress rather than a single frozen line.
    const results = await captureAll(tabs, captureTab, (done) => {
        setStatus("Read " + done + " of " + total + " " + noun + "...");
    });
    const failed = results.filter((r) => !r.ok).length;
    const timedOut = results.filter(
        (r) => !r.ok && typeof r.error === "string" && r.error.includes("Timed out")
    ).length;

    // Serializing a large export can take a beat. Show a phase and yield once so
    // the message paints before the synchronous stringify blocks the thread.
    setStatus("Processing " + total + " " + noun + "...");
    await new Promise((resolve) => setTimeout(resolve));

    const payload = {
        exported_at: new Date().toISOString(),
        tab_count: results.length,
        tabs: results
    };

    const indent = settings.prettyJson ? 2 : 0;
    return {
        json: JSON.stringify(payload, null, indent),
        count: results.length,
        failed: failed,
        timedOut: timedOut
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

/**
 * Deliver a built export as a downloaded file. Saves straight to the browser's
 * downloads folder under the timestamped name, with no Save As dialog: forcing
 * the dialog can hang in some browsers (a blocked prompt queues repeat downloads)
 * and the timestamped name means the file rarely needs renaming anyway.
 */
async function deliverDownload({ json, count, failed, timedOut }) {
    setStatus("Saving...");
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
        await chrome.downloads.download({
            url: url,
            filename: timestampName(),
            saveAs: false
        });
    } finally {
        // Release the object URL once the download has had time to start, whether
        // or not it succeeded, so a failed or cancelled save does not leak it.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    const noun = count === 1 ? "tab" : "tabs";
    setStatus(
        "Downloaded " + count + " " + noun + "." + failureNote(failed, timedOut),
        count > 0 && failed === count
    );
}

/** Deliver a built export to the clipboard. */
async function deliverCopy({ json, count, failed, timedOut }) {
    setStatus("Copying...");
    await navigator.clipboard.writeText(json);
    const noun = count === 1 ? "tab" : "tabs";
    setStatus(
        "Copied " + count + " " + noun + " to clipboard." + failureNote(failed, timedOut),
        count > 0 && failed === count
    );
}

// One export at a time. guardConcurrent ignores a click while an export is in
// flight, and the buttons are disabled for the duration, so a slow or blocked
// Save As dialog cannot lead to a stack of queued downloads.
const runExport = guardConcurrent(async (deliver, failVerb) => {
    downloadBtn.disabled = true;
    copyBtn.disabled = true;
    try {
        const result = await buildExport();
        await deliver(result);
    } catch (err) {
        setStatus(failVerb + " failed: " + (err && err.message ? err.message : err), true);
    } finally {
        downloadBtn.disabled = false;
        copyBtn.disabled = false;
    }
});

downloadBtn.addEventListener("click", () => runExport(deliverDownload, "Download"));
copyBtn.addEventListener("click", () => runExport(deliverCopy, "Copy"));

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