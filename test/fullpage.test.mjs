import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "./harness.mjs";
import {
    buildRecord,
    stitchFrameText,
    stitchFrameHeadings,
    wordCount,
    DEFAULT_SETTINGS,
    LOW_SIGNAL_MIN_CHARS
} from "../src/lib/extract.js";

const AT = "2026-10-01T12:00:00.000Z";
const on = (o) => ({ ...DEFAULT_SETTINGS, captureFullPage: true, ...o });
const off = (o) => ({ ...DEFAULT_SETTINGS, ...o });
const frame = (frameId, html, url, full) => ({
    frameId,
    result: extract(html, url, LOW_SIGNAL_MIN_CHARS, full)
});

// A page whose content sits outside any landmark, with a nav bar and a footer the
// normal path would peel or miss.
const AWKWARD_HTML = `<!DOCTYPE html><html lang="en"><head><title>A Page</title></head><body>
  <nav>Home Products Pricing Support Contact About Careers Blog Legal</nav>
  <div><span>${"The thing we actually came here to read lives in a plain span. ".repeat(10)}</span></div>
  <footer>Copyright 2026. Privacy. Terms.</footer></body></html>`;

const SIDE_HTML = `<!DOCTYPE html><html lang="en"><head><title>Side</title></head><body>
  <main><h2>Side Frame Heading</h2>
  <p>${"Text that lives only inside the embedded frame. ".repeat(10)}</p></main></body></html>`;

const PAGE_URL = "https://example.com/page";
const SIDE_URL = "https://widget.example.net/embed";

test("the setting is off by default, so nothing changes without asking", () => {
    assert.equal(DEFAULT_SETTINGS.captureFullPage, false);
});

test("whole-page capture keeps the nav and footer the normal path drops", () => {
    const normal = extract(AWKWARD_HTML, PAGE_URL);
    const full = extract(AWKWARD_HTML, PAGE_URL, LOW_SIGNAL_MIN_CHARS, true);

    assert.equal(full.contentSource, "full-page");
    assert.ok(full.rawText.includes("Home Products Pricing"), "nav is kept");
    assert.ok(full.rawText.includes("Copyright 2026"), "footer is kept");
    assert.ok(
        wordCount(full.rawText) > wordCount(normal.rawText),
        "whole-page capture yields more, not less"
    );
});

test("stitchFrameText joins every frame, top frame first", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const side = frame(2, SIDE_HTML, SIDE_URL, true);
    const text = stitchFrameText([top, side], top);

    assert.ok(text.includes("plain span"), "top frame text present");
    assert.ok(text.includes("only inside the embedded frame"), "sub-frame text present");
    assert.ok(
        text.indexOf("plain span") < text.indexOf("only inside the embedded frame"),
        "top frame comes first"
    );
});

test("stitchFrameText leaves junk frames out", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const captcha = frame(
        3,
        `<!DOCTYPE html><html><body><p>${"recaptcha noise ".repeat(60)}</p></body></html>`,
        "https://www.google.com/recaptcha/api2/anchor",
        true
    );
    const text = stitchFrameText([top, captcha], top);
    assert.ok(!text.includes("recaptcha noise"), "a captcha frame is not page content");
});

test("stitchFrameText survives empty and malformed frames", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    assert.ok(stitchFrameText([top, { frameId: 9, result: null }], top).length > 0);
    assert.equal(typeof stitchFrameText([], top), "string");
    assert.equal(stitchFrameText(null, { result: { rawText: "x" } }), "x");
});

test("stitchFrameHeadings collects from every frame and caps at 60", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const side = frame(2, SIDE_HTML, SIDE_URL, true);
    const headings = stitchFrameHeadings([top, side], top);
    assert.ok(headings.some((h) => h.text === "Side Frame Heading"));
    assert.ok(headings.length <= 60);
});

test("the record reports full-page and carries every frame's text", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const side = frame(2, SIDE_HTML, SIDE_URL, true);
    const r = buildRecord({ id: 1, title: "A Page", url: PAGE_URL }, [top, side], on(), AT);

    assert.equal(r.content_source, "full-page");
    assert.ok(r.text.includes("plain span"));
    assert.ok(r.text.includes("only inside the embedded frame"));
    assert.ok(!("content_frame_url" in r), "no single frame was chosen");
});

test("the character cap still applies under whole-page capture", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const r = buildRecord(
        { id: 2, title: "A Page", url: PAGE_URL }, [top], on({ maxTextChars: 80 }), AT
    );
    assert.ok(r.text.length <= 80);
    assert.equal(r.text_truncated, true);
});

test("a genuinely empty page is still reported low signal", () => {
    const empty = frame(0, `<!DOCTYPE html><html><body><div></div></body></html>`, PAGE_URL, true);
    const r = buildRecord({ id: 3, title: "Empty", url: PAGE_URL }, [empty], on(), AT);
    assert.equal(r.low_signal, true);
});

test("a page the normal path reads fine is not made low signal by the switch", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, true);
    const r = buildRecord({ id: 4, title: "A Page", url: PAGE_URL }, [top], on(), AT);
    assert.ok(!("low_signal" in r));
});

test("the setting off leaves the record exactly as before", () => {
    const top = frame(0, AWKWARD_HTML, PAGE_URL, false);
    const r = buildRecord({ id: 5, title: "A Page", url: PAGE_URL }, [top], off(), AT);
    assert.notEqual(r.content_source, "full-page");
});
