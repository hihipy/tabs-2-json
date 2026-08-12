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
    guardConcurrent,
    shouldCloseAfterDownload,
    buildTabSections,
    normalizeSelectionScope
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

/** The most recent tab groups, retained for the same reason. */
let allGroups = [];

/** The window the popup was opened from, so its section can sort and label first. */
let currentWindowId = null;

/**
 * The window whose tabs open expanded and start selected. Normally the window the
 * popup was opened from. Null when the list is a single window, where the
 * distinction does not arise.
 */
let defaultWindowId = null;

/**
 * Window ids the user has collapsed, or expanded against the default. Held so a
 * re-render (a settings change, a refresh) does not throw away what the user
 * opened. Ids are session-scoped, which is fine for a popup that does not outlive
 * the session.
 */
const collapseOverrides = new Map();

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
 * Return the enabled tab checkboxes currently in the list. Header checkboxes are
 * excluded: only a row carrying data-tab-id stands for a tab that can be read.
 * @returns {HTMLInputElement[]}
 */
function checkboxes() {
    return Array.from(
        tabListEl.querySelectorAll("input[type=checkbox][data-tab-id]:not(:disabled)")
    );
}

/**
 * Set a header checkbox from the tab checkboxes it governs, and write its count.
 * A header with some but not all of its tabs selected shows the browser's
 * indeterminate dash, which distinguishes a partial window from an empty one at a
 * glance.
 * @param {HTMLInputElement} header
 * @param {HTMLInputElement[]} members Enabled tab checkboxes under this header.
 */
function syncHeader(header, members) {
    const selected = members.filter((box) => box.checked).length;

    header.checked = members.length > 0 && selected === members.length;
    header.indeterminate = selected > 0 && selected < members.length;
    header.disabled = members.length === 0;

    const countLabel = header.closest("li").querySelector(".section-count");
    if (countLabel) {
        countLabel.textContent =
            members.length === 0 ? "None readable" : selected + " of " + members.length;
    }
}

/**
 * Return the enabled tab checkboxes governed by a header.
 * @param {HTMLInputElement} header
 * @returns {HTMLInputElement[]}
 */
function membersOf(header) {
    const boxes = checkboxes();
    if (header.dataset.group) {
        return boxes.filter((box) => box.dataset.group === header.dataset.group);
    }
    return boxes.filter((box) => box.dataset.window === header.dataset.window);
}

/**
 * Refresh the selection count, every header state, and the enabled state of the
 * action buttons.
 */
function updateCount() {
    const boxes = checkboxes();
    const selected = boxes.filter((b) => b.checked).length;
    countEl.textContent = selected + " of " + boxes.length + " selected";

    selectAllEl.checked = boxes.length > 0 && selected === boxes.length;
    selectAllEl.indeterminate = selected > 0 && selected < boxes.length;

    tabListEl
        .querySelectorAll("input[type=checkbox][data-scope]")
        .forEach((header) => syncHeader(header, membersOf(header)));

    const none = selected === 0;
    downloadBtn.disabled = none;
    copyBtn.disabled = none;
}

/**
 * Whether a window section should render collapsed. The default window opens
 * expanded because it is the one the user is looking at; the others start
 * collapsed so several open windows do not reproduce the flat list this structure
 * exists to break up. An explicit toggle always wins over the default.
 * @param {Object} section
 * @returns {boolean}
 */
function isCollapsed(section) {
    if (collapseOverrides.has(section.windowId)) {
        return collapseOverrides.get(section.windowId);
    }
    // Selecting everything means the user wants to see everything, so nothing
    // starts hidden.
    if (normalizeSelectionScope(settings.defaultSelection) === "all") {
        return false;
    }
    return section.windowId !== defaultWindowId;
}

/**
 * Choose the window that opens expanded and starts selected.
 *
 * Expansion and selection are answered by this one function so they cannot
 * disagree. If they did, a collapsed window's tabs could be selected, and a plain
 * Download would export pages the user never saw in the list.
 *
 * Normally this is the window the popup was opened from. When that could not be
 * identified, the first section stands in, so some window is always expanded and
 * the popup never opens with nothing selected.
 * @param {Array<Object>} sections
 * @returns {(number|null)}
 */
function resolveDefaultWindow(sections) {
    if (sections.length === 0) {
        return null;
    }
    const match = sections.some((section) => section.windowId === currentWindowId);
    return match ? currentWindowId : sections[0].windowId;
}

/**
 * Show or hide the rows belonging to one window, and point its chevron.
 *
 * Hiding uses a class rather than the hidden attribute. The attribute is styled
 * display:none by the browser's default stylesheet, which a class selector on the
 * row overrides, so a flex row stays visible with hidden set on it.
 * @param {number} windowId
 * @param {boolean} collapsed
 */
function applyCollapse(windowId, collapsed) {
    const key = String(windowId);

    tabListEl.querySelectorAll('[data-window="' + key + '"]').forEach((el) => {
        if (el.classList.contains("window-row")) {
            return;
        }
        el.classList.toggle("collapsed-member", collapsed);
    });

    const header = tabListEl.querySelector('.window-row[data-window="' + key + '"]');
    if (header) {
        const toggle = header.querySelector(".section-toggle");
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.querySelector(".chevron").textContent = collapsed ? "\u25B8" : "\u25BE";
    }
}

/**
 * Build one tab row.
 * @param {chrome.tabs.Tab} tab
 * @param {number} windowId
 * @param {(Object|null)} group The group item the row sits in, or null when the
 *   tab belongs to no group.
 * @param {boolean} selectByDefault Whether the row starts checked, assuming the
 *   tab can be read at all.
 * @returns {HTMLLIElement}
 */
function tabRow(tab, windowId, group, selectByDefault) {
    const reason = captureBlockReason(tab);
    const capturable = reason === null;

    const row = document.createElement("li");
    row.className = "tab-row" + (capturable ? "" : " restricted");
    row.dataset.window = String(windowId);
    if (group) {
        row.dataset.group = String(group.groupId);
        row.dataset.color = group.color;
        row.classList.add("in-group");
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = capturable && selectByDefault;
    checkbox.disabled = !capturable;
    checkbox.dataset.tabId = String(tab.id);
    checkbox.dataset.window = String(windowId);
    if (group) {
        checkbox.dataset.group = String(group.groupId);
    }
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
    return row;
}

/**
 * Build a header checkbox that selects or clears everything beneath it.
 * @param {string} scope Either "window" or "group".
 * @param {string} key The window or group id, as a string.
 * @param {string} ariaLabel
 * @returns {HTMLInputElement}
 */
function headerCheckbox(scope, key, ariaLabel) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.scope = scope;
    box.dataset[scope] = key;
    box.setAttribute("aria-label", ariaLabel);

    box.addEventListener("change", () => {
        // A header the user clicks while it shows the dash selects everything,
        // which is the reading that saves work: a partial selection is on its way
        // to being whole more often than on its way to being empty.
        const target = box.checked;
        membersOf(box).forEach((member) => {
            member.checked = target;
        });
        updateCount();
    });

    return box;
}

/**
 * Build a window header row: a checkbox that selects the whole window, and a
 * button that collapses it.
 * @param {Object} section
 * @returns {HTMLLIElement}
 */
function windowRow(section) {
    const row = document.createElement("li");
    row.className = "window-row";
    row.dataset.window = String(section.windowId);

    const box = headerCheckbox(
        "window",
        String(section.windowId),
        "Select every readable tab in " + section.label
    );

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "section-toggle";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "section-label";
    label.textContent = section.label;

    const count = document.createElement("span");
    count.className = "section-count";

    toggle.append(chevron, label, count);

    toggle.addEventListener("click", () => {
        const next = !isCollapsed(section);
        collapseOverrides.set(section.windowId, next);
        applyCollapse(section.windowId, next);
    });

    // The active tab's title identifies a window the user cannot see, which a
    // number alone does not.
    if (!section.isCurrent && section.activeTitle) {
        const hint = document.createElement("span");
        hint.className = "section-hint";
        hint.textContent = section.activeTitle;
        toggle.append(hint);
    }

    row.append(box, toggle);
    return row;
}

/**
 * Build a group header row.
 * @param {Object} item A group item from buildTabSections.
 * @param {number} windowId
 * @returns {HTMLLIElement}
 */
function groupRow(item, windowId) {
    const row = document.createElement("li");
    row.className = "group-row";
    row.dataset.window = String(windowId);
    row.dataset.group = String(item.groupId);
    row.dataset.color = item.color;

    const box = headerCheckbox(
        "group",
        String(item.groupId),
        "Select every readable tab in the " + item.title + " group"
    );

    const label = document.createElement("span");
    label.className = "section-label group-label";
    label.textContent = item.title;

    const count = document.createElement("span");
    count.className = "section-count";

    const label_el = document.createElement("label");
    label_el.style.display = "contents";
    label_el.append(box, label);

    row.append(label_el, count);
    return row;
}

/**
 * Render the tab list as one section per window, with groups nested inside their
 * window. Capturable tabs are checked by default; restricted and blocked tabs are
 * shown disabled with an explanatory tag. A window whose tabs are all unreadable
 * still renders, with a disabled header, because a silently missing window is
 * harder to understand than a visibly unusable one.
 * @param {chrome.tabs.Tab[]} tabs
 */
function renderTabs(tabs) {
    tabListEl.innerHTML = "";

    const scope = normalizeSelectionScope(settings.defaultSelection);

    // Dropping unreadable tabs here rather than at render time also drops any
    // window left with nothing in it, since buildTabSections only makes a section
    // for a window that has tabs.
    const listed = settings.hideUnreadable
        ? tabs.filter((tab) => captureBlockReason(tab) === null)
        : tabs;

    const sections = buildTabSections(listed, allGroups, currentWindowId);

    // With one window there is nothing to distinguish, so the headers would only
    // add a row the user has to look past.
    const flat = sections.length < 2;

    defaultWindowId = flat ? null : resolveDefaultWindow(sections);

    sections.forEach((section) => {
        // What is selected stays limited to what the user can see, so a plain
        // Download never picks up a tab from a collapsed window.
        const selectByDefault =
            scope === "none"
                ? false
                : scope === "all" || flat || section.windowId === defaultWindowId;

        if (!flat) {
            tabListEl.append(windowRow(section));
        }

        section.items.forEach((item) => {
            if (item.kind === "group") {
                tabListEl.append(groupRow(item, section.windowId));
                item.tabs.forEach((tab) => {
                    tabListEl.append(tabRow(tab, section.windowId, item, selectByDefault));
                });
                return;
            }
            tabListEl.append(tabRow(item.tab, section.windowId, null, selectByDefault));
        });
    });

    if (!flat) {
        sections.forEach((section) => {
            applyCollapse(section.windowId, isCollapsed(section));
        });
    }

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
 * Deliver a built export as a downloaded file. Nothing about the download is owned
 * here. The popup hands the JSON to the background service worker, which parks it
 * in an offscreen document as a Blob and starts the download from there, so the
 * file's bytes and the download itself both outlive this popup.
 *
 * The worker acknowledges as soon as the blob is ready and before it opens the
 * Save As dialog, which is what lets the popup get out of the way first: by the
 * time the dialog appears, the popup is gone and no longer covers it or the
 * browser's download button. An acknowledgement that reports a failure leaves the
 * popup open so the error is readable.
 */
async function deliverDownload({ json, count, failed, timedOut }) {
    setStatus("Preparing the file...");
    const noun = count === 1 ? "tab" : "tabs";

    const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "download",
        json: json,
        filename: timestampName()
    });

    if (!response || !response.ok) {
        throw new Error(
            (response && response.error) || "The download could not be started."
        );
    }

    // On a fully clean export, close now so the Save As dialog is unobstructed. On
    // a partial failure, stay open so the note is readable; the dialog still fires.
    if (shouldCloseAfterDownload(count, failed)) {
        window.close();
        return;
    }

    setStatus(
        "Saving " + count + " " + noun + "." + failureNote(failed, timedOut),
        count > 0 && failed === count
    );
}

/** Deliver a built export to the clipboard. Leaves the popup open. */
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
 * Identify the browser window the user was looking at when they opened the popup.
 *
 * chrome.windows.getCurrent can report the popup's own window rather than the
 * browser window behind it, and that id holds none of the queried tabs. So the
 * active tab of the last focused window is asked first, and every candidate is
 * checked against the windows that actually have tabs. Returning null is a valid
 * answer: the list then numbers every window instead of naming one "this window".
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {Promise<(number|null)>}
 */
async function findCurrentWindowId(tabs) {
    const withTabs = new Set(tabs.map((tab) => tab.windowId));

    try {
        const active = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });
        const tab = active && active[0];
        if (tab && withTabs.has(tab.windowId)) {
            return tab.windowId;
        }
    } catch (err) {
        // Fall through to the window lookup below.
    }

    try {
        const win = await chrome.windows.getCurrent();
        if (win && withTabs.has(win.id)) {
            return win.id;
        }
    } catch (err) {
        // Fall through.
    }

    return null;
}

/**
 * Read the open tab groups. Returns an empty list when the browser has no
 * tabGroups API, which leaves every tab ungrouped rather than failing the load:
 * grouping is presentation, and the export works without it.
 * @returns {Promise<Array<Object>>}
 */
async function loadGroups() {
    if (!chrome.tabGroups || !chrome.tabGroups.query) {
        return [];
    }
    try {
        return await chrome.tabGroups.query({});
    } catch (err) {
        return [];
    }
}

/**
 * Query all open tabs and groups, retain them, and render the list. The window
 * lookup and the group query run alongside the tab query, since none depends on
 * another.
 * @returns {Promise<void>}
 */
async function loadTabs() {
    try {
        const [tabs, groups] = await Promise.all([
            chrome.tabs.query({}),
            loadGroups()
        ]);

        allTabs = tabs;
        allGroups = groups;
        currentWindowId = await findCurrentWindowId(tabs);

        renderTabs(allTabs);

        const anyCapturable = allTabs.some((tab) => captureBlockReason(tab) === null);
        const anySelected = checkboxes().some((box) => box.checked);

        if (!anyCapturable) {
            setStatus("No readable tabs are open.");
        } else if (!anySelected && normalizeSelectionScope(settings.defaultSelection) !== "none") {
            // Readable tabs exist, but not in the window that opened expanded, so
            // both buttons are disabled. Say why rather than leaving a dead end.
            // Silent when the user chose to start with nothing selected, since an
            // empty selection is then the setting working.
            setStatus("Nothing readable in this window. Expand another to select tabs.");
        } else {
            setStatus("");
        }
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
        const previousScope = normalizeSelectionScope(settings.defaultSelection);
        settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };

        // A new selection scope carries a new idea of what should be open, so the
        // toggles the user made under the old one no longer apply. Other settings
        // leave them alone.
        if (normalizeSelectionScope(settings.defaultSelection) !== previousScope) {
            collapseOverrides.clear();
        }
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