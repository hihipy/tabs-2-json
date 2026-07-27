/**
 * Offscreen document script: owner of the export blob.
 *
 * A service worker has no URL.createObjectURL, and the popup cannot own the blob
 * because closing the popup destroys it and strands the download. This document
 * has neither problem: it can create blob URLs, and its lifetime is separate from
 * both the popup and the service worker, so the file's bytes stay readable while
 * the Save As dialog is open and while the file is written.
 *
 * Only chrome.runtime is available to an offscreen document, so the download
 * itself is started by the service worker; this side only produces the URL.
 *
 * Blob encodes a JavaScript string as UTF-8, so accented and CJK text survives
 * without any manual encoding step.
 */

/** The blob URL for the current export, if any. */
let activeUrl = null;

/** Release the current blob URL. */
function revokeActive() {
    if (activeUrl) {
        URL.revokeObjectURL(activeUrl);
        activeUrl = null;
    }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") {
        return false;
    }

    if (message.type === "create-blob-url") {
        try {
            // A document left over from an interrupted export still holds its blob.
            // Drop it before making a new one so memory does not accumulate.
            revokeActive();

            const blob = new Blob([message.json || ""], { type: "application/json" });
            activeUrl = URL.createObjectURL(blob);
            sendResponse({ url: activeUrl });
        } catch (err) {
            sendResponse({ error: err && err.message ? err.message : String(err) });
        }
        return false;
    }

    if (message.type === "revoke-blob-url") {
        revokeActive();
        sendResponse({ ok: true });
        return false;
    }

    return false;
});
