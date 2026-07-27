/**
 * Background service worker.
 *
 * This worker owns the export download. The popup cannot: a popup is torn down
 * the instant it closes, and anything it owns goes with it, which is what left
 * every earlier attempt sitting as a pending download.
 *
 * The file's bytes live in a Blob held by an offscreen document, not in the URL.
 * Chromium caps a URL at 2 MB, and an export of a few content-heavy pages,
 * pretty-printed and then percent-encoded, clears that easily; an over-long
 * download URL does not fail cleanly. A blob URL carries a reference rather than
 * the payload, so payload size stops mattering. A service worker cannot call
 * URL.createObjectURL, which is why the Blob is created in an offscreen document
 * (the "BLOBS" reason exists for exactly this) and only the short blob: URL comes
 * back here.
 *
 * Ordering is the other half of the fix. The worker prepares the blob URL, tells
 * the popup it may close, waits a beat, and only then starts the download. Any
 * dialog therefore opens with the popup already gone, so it never sits over the
 * dialog or the download button, and the download's source is owned by the
 * offscreen document, which outlives the popup.
 */

/** Path to the offscreen document, relative to the extension root. */
const OFFSCREEN_PATH = "src/offscreen.html";

/**
 * How long to wait after acknowledging the popup before opening the Save As
 * dialog. The popup closes on the acknowledgement; this gives that close a moment
 * to land so the dialog is never drawn underneath it. Short enough to read as
 * instant, long enough to win the race.
 */
const POPUP_CLOSE_GRACE_MS = 120;

/**
 * Ceiling on how long the offscreen document is held open waiting for a download
 * to finish. Generous, because the user may sit in a Save As dialog, but finite,
 * so a download that never settles cannot pin the document open indefinitely.
 */
const TERMINAL_WAIT_CEILING_MS = 600000;

/** Guards against two exports each trying to create the offscreen document. */
let creating = null;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the extension already has its offscreen document open. getContexts
 * landed in Chrome 116; clients.matchAll covers anything older.
 * @returns {Promise<boolean>}
 */
async function hasOffscreenDocument() {
    const url = chrome.runtime.getURL(OFFSCREEN_PATH);

    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [url]
        });
        return contexts.length > 0;
    }

    const matched = await self.clients.matchAll();
    return matched.some((client) => client.url === url);
}

/**
 * Open the offscreen document if it is not already open. An extension may have
 * only one at a time, so a leftover document from a previous export is reused
 * rather than replaced; the document revokes its old blob URL when asked for a
 * new one.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }

    if (creating) {
        await creating;
        return;
    }

    creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"],
        justification:
            "Hold the exported JSON as a Blob so the download outlives the popup that started it."
    });

    try {
        await creating;
    } finally {
        creating = null;
    }
}

/**
 * Close the offscreen document, releasing its blob. Safe to call when no document
 * is open.
 * @returns {Promise<void>}
 */
async function closeOffscreenDocument() {
    try {
        if (await hasOffscreenDocument()) {
            await chrome.offscreen.closeDocument();
        }
    } catch (err) {
        console.warn("Tabs2JSON could not close the offscreen document:", err);
    }
}

/**
 * Hand the JSON to the offscreen document and get back a blob URL for it.
 * @param {string} json
 * @returns {Promise<string>}
 */
async function createBlobUrl(json) {
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "create-blob-url",
        json: json
    });

    if (!response || !response.url) {
        throw new Error(
            (response && response.error) || "The file could not be prepared for download."
        );
    }

    return response.url;
}

/**
 * Resolve once the download has finished or failed. The item can already be in a
 * terminal state before the listener attaches (a local blob writes fast), so the
 * current state is checked as well. The wait is bounded: a download that never
 * settles must not hold the offscreen document open for the rest of the session.
 * @param {number} id DownloadItem id.
 * @returns {Promise<void>}
 */
function waitForTerminalState(id) {
    return new Promise((resolve) => {
        const isTerminal = (state) => state === "complete" || state === "interrupted";
        let timer = null;

        const finish = () => {
            chrome.downloads.onChanged.removeListener(onChanged);
            if (timer !== null) {
                clearTimeout(timer);
            }
            resolve();
        };

        const onChanged = (delta) => {
            if (delta.id === id && delta.state && isTerminal(delta.state.current)) {
                finish();
            }
        };

        chrome.downloads.onChanged.addListener(onChanged);
        timer = setTimeout(finish, TERMINAL_WAIT_CEILING_MS);

        chrome.downloads
            .search({ id: id })
            .then((items) => {
                const item = items && items[0];
                if (item && isTerminal(item.state)) {
                    finish();
                }
            })
            .catch(() => {
                // Nothing to do: the listener above still covers the normal path.
            });
    });
}

/**
 * Start the download and hold the blob until the file is written.
 *
 * saveAs is deliberately false. Every attempt in this extension's history that
 * passed saveAs:true produced no dialog and a download that never progressed,
 * from the popup and from here alike; the only call that ever wrote a file used
 * saveAs:false. The Save As dialog comes instead from Brave's own setting, "Ask
 * where to save each file before downloading" (brave://settings/downloads). With
 * that on, every download prompts, this one included, pre-filled with the name
 * below. With it off, the file lands in the downloads folder under that name.
 * @param {string} url Blob URL owned by the offscreen document.
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function runDownload(url, filename) {
    try {
        const id = await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
        });
        await waitForTerminalState(id);
    } catch (err) {
        // The dialog was cancelled, or the download never started. Either way
        // nothing is going to read the blob.
        console.warn("Tabs2JSON download did not start:", err);
    } finally {
        await closeOffscreenDocument();
    }
}

/**
 * Prepare the blob, release the popup, then open the dialog.
 * @param {Object} message
 * @param {function} sendResponse
 * @returns {Promise<void>}
 */
async function handleDownload(message, sendResponse) {
    let url;

    try {
        url = await createBlobUrl(message.json || "");
    } catch (err) {
        // Report the failure instead of acknowledging, so the popup stays open and
        // shows it rather than closing over a download that never happened.
        sendResponse({
            ok: false,
            error: err && err.message ? err.message : String(err)
        });
        await closeOffscreenDocument();
        return;
    }

    sendResponse({ ok: true });

    await delay(POPUP_CLOSE_GRACE_MS);
    await runDownload(url, message.filename);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target === "offscreen" || message.type !== "download") {
        return false;
    }

    handleDownload(message, sendResponse);

    // The acknowledgement is sent from an async function, so the channel has to
    // stay open.
    return true;
});
