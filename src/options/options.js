/**
 * Tabs2JSON options controller.
 *
 * Loads the stored settings into the form, saves changes automatically, and
 * keeps the page theme in sync with the user's preference.
 */

import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  clampInt,
  parseDomains,
  normalizeSelectionScope
} from "../lib/extract.js";

const THEME_KEY = "theme";

const el = {
  defaultSelection: document.getElementById("default-selection"),
  hideUnreadable: document.getElementById("hide-unreadable"),
  includeText: document.getElementById("include-text"),
  includeStructured: document.getElementById("include-structured"),
  includeHeadings: document.getElementById("include-headings"),
  trimVideo: document.getElementById("trim-video"),
  maxChars: document.getElementById("max-chars"),
  stripParams: document.getElementById("strip-params"),
  blocked: document.getElementById("blocked-domains"),
  pretty: document.getElementById("pretty-json"),
  saved: document.getElementById("saved")
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Apply a theme preference to the document root.
 * @param {string} pref One of "auto", "light", or "dark".
 */
function applyTheme(pref) {
  const resolved =
      pref === "light" || pref === "dark"
          ? pref
          : darkQuery.matches
              ? "dark"
              : "light";
  document.documentElement.setAttribute("data-theme", resolved);
}

darkQuery.addEventListener("change", async () => {
  const stored = await chrome.storage.local.get(THEME_KEY);
  if ((stored[THEME_KEY] || "auto") === "auto") {
    applyTheme("auto");
  }
});

// ---------------------------------------------------------------------------
// Load and save
// ---------------------------------------------------------------------------

/**
 * Populate the form fields from stored settings.
 * @returns {Promise<void>}
 */
async function loadForm() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

  el.defaultSelection.value = normalizeSelectionScope(settings.defaultSelection);
  el.hideUnreadable.checked = settings.hideUnreadable;
  el.includeText.checked = settings.includeText;
  el.includeStructured.checked = settings.includeStructuredData;
  el.includeHeadings.checked = settings.includeHeadings;
  el.trimVideo.checked = settings.trimVideoText;
  el.maxChars.value = settings.maxTextChars;
  el.stripParams.checked = settings.stripUrlParams;
  el.blocked.value = (settings.blockedDomains || []).join("\n");
  el.pretty.checked = settings.prettyJson;
}

/**
 * Read the current form state into a settings object.
 * @returns {Object}
 */
function readForm() {
  return {
    defaultSelection: normalizeSelectionScope(el.defaultSelection.value),
    hideUnreadable: el.hideUnreadable.checked,
    includeText: el.includeText.checked,
    includeStructuredData: el.includeStructured.checked,
    includeHeadings: el.includeHeadings.checked,
    trimVideoText: el.trimVideo.checked,
    maxTextChars: clampInt(el.maxChars.value, 0),
    stripUrlParams: el.stripParams.checked,
    blockedDomains: parseDomains(el.blocked.value),
    prettyJson: el.pretty.checked
  };
}

let savedTimer = null;

/**
 * Persist the form state, then briefly show the "Saved" confirmation and fade
 * it back out.
 * @returns {Promise<void>}
 */
async function save() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: readForm() });

  el.saved.textContent = "Saved";
  el.saved.classList.add("visible");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.saved.classList.remove("visible");
  }, 1500);
}

// Save whenever any control changes.
[
  el.defaultSelection,
  el.hideUnreadable,
  el.includeText,
  el.includeStructured,
  el.includeHeadings,
  el.trimVideo,
  el.maxChars,
  el.stripParams,
  el.pretty
].forEach((control) => {
  control.addEventListener("change", save);
});

// The blocked-domains textarea normalises on save, so persist the parsed list
// once the field loses focus rather than on every keystroke.
el.blocked.addEventListener("change", save);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialise the options page: apply theme and load the form.
 * @returns {Promise<void>}
 */
async function init() {
  const versionEl = document.getElementById("version");
  if (versionEl) {
    versionEl.textContent = "Version " + chrome.runtime.getManifest().version;
  }
  const stored = await chrome.storage.local.get(THEME_KEY);
  applyTheme(stored[THEME_KEY] || "auto");
  await loadForm();
}

init();
