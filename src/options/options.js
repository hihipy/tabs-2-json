/**
 * Tabs2JSON options controller.
 *
 * Loads the stored settings into the form, saves changes automatically, and
 * keeps the page theme in sync with the user's preference.
 */

const SETTINGS_KEY = "settings";
const THEME_KEY = "theme";

/** Default settings, kept in sync with the popup defaults. */
const DEFAULT_SETTINGS = {
  includeText: true,
  includeStructuredData: true,
  includeHeadings: true,
  trimVideoText: true,
  maxTextChars: 0,
  stripUrlParams: false,
  blockedDomains: [],
  prettyJson: true
};

const el = {
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
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an integer from a string, clamping to a minimum.
 * @param {string} value
 * @param {number} min
 * @returns {number}
 */
function clampInt(value, min) {
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
function parseDomains(raw) {
  const parts = String(raw || "")
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  return Array.from(new Set(parts));
}

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
  const stored = await chrome.storage.local.get(THEME_KEY);
  applyTheme(stored[THEME_KEY] || "auto");
  await loadForm();
}

init();