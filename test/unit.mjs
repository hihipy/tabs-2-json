/**
 * Unit tests for the pure logic in src/popup/popup.js.
 *
 * These run on plain Node with no dependencies:  node test/unit.mjs
 *
 * The functions below are copied verbatim from popup.js rather than imported,
 * because popup.js runs DOM and chrome calls at load time and cannot be
 * imported outside the extension. Keep these definitions in sync with
 * src/popup/popup.js when that logic changes.
 *
 * stripHtml and the markup path of sanitizeStructured need a DOMParser. That
 * exists in a browser (or under jsdom) but not in plain Node, so those checks
 * run only when DOMParser is present and are skipped, not failed, otherwise.
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Functions under test (mirror of src/popup/popup.js)
// ---------------------------------------------------------------------------

function cleanText(text) {
    return (text || "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function prune(obj) {
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

const HTML_TAG = /<[a-z!/][^>]*>/i;

function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript, template").forEach((el) => {
        el.remove();
    });
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function sanitizeStructured(node) {
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

function timestampName() {
    const iso = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return "tabs2json-" + iso + ".json";
}

// Leading-chrome peel, extracted from pageExtractor. The two nested helpers are
// verbatim; peelChrome wraps the loop so it can be called with a plain list of
// chrome-block texts instead of a live DOM.
const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();

const sliceAfterNormalized = (original, normCount) => {
    let seen = 0;
    let inGap = true;
    let i = 0;
    for (; i < original.length && seen < normCount; i++) {
        if (/\s/.test(original[i])) {
            if (!inGap) {
                seen += 1;
                inGap = true;
            }
        } else {
            seen += 1;
            inGap = false;
        }
    }
    return original.slice(i);
};

function peelChrome(rootText, chromeBlocks) {
    const chromeTexts = chromeBlocks
        .map(normalize)
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
    return rootText;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log("  ok    " + name);
    } catch (err) {
        failed += 1;
        console.log("  FAIL  " + name);
        console.log("        " + (err && err.message ? err.message.split("\n")[0] : err));
    }
}

function skip(name, reason) {
    skipped += 1;
    console.log("  skip  " + name + "  (" + reason + ")");
}

// ---------------------------------------------------------------------------
// cleanText
// ---------------------------------------------------------------------------

console.log("cleanText");
test("trims each line and drops carriage returns", () => {
    assert.equal(cleanText("  a \r\n  b  "), "a\nb");
});
test("collapses 3 or more blank lines to one blank line", () => {
    assert.equal(cleanText("a\n\n\n\n\nb"), "a\n\nb");
});
test("keeps a single blank line between blocks", () => {
    assert.equal(cleanText("a\n\nb"), "a\n\nb");
});
test("returns empty string for null and undefined input", () => {
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

console.log("prune");
test("drops null, undefined, empty string, and empty array", () => {
    const out = prune({ a: null, b: undefined, c: "", d: [], e: "keep" });
    assert.deepEqual(out, { e: "keep" });
});
test("keeps boolean false and the number zero", () => {
    const out = prune({ flag: false, n: 0 });
    assert.deepEqual(out, { flag: false, n: 0 });
});
test("keeps whitespace-only strings only when they have content", () => {
    assert.deepEqual(prune({ a: "   " }), {});
    assert.deepEqual(prune({ a: " x " }), { a: " x " });
});

// ---------------------------------------------------------------------------
// timestampName
// ---------------------------------------------------------------------------

console.log("timestampName");
test("matches the tabs2json-<iso>.json shape with no colons", () => {
    assert.match(timestampName(), /^tabs2json-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
});

// ---------------------------------------------------------------------------
// sanitizeStructured: DOM-free behaviour (no DOMParser needed)
// ---------------------------------------------------------------------------

console.log("sanitizeStructured (structure)");
test("leaves a plain string untouched", () => {
    assert.equal(sanitizeStructured("Frankfort, KY"), "Frankfort, KY");
});
test("leaves a bare < that is not a tag untouched", () => {
    assert.equal(sanitizeStructured("a < b and c > d"), "a < b and c > d");
});
test("leaves a URL with query params untouched", () => {
    assert.equal(sanitizeStructured("https://x.com/a?b=1&c=2"), "https://x.com/a?b=1&c=2");
});
test("recurses arrays and objects, preserving @type and non-markup values", () => {
    const out = sanitizeStructured({
        "@type": "JobPosting",
        Title: "Data Analyst",
        org: { "@type": "Organization", name: "Kentucky" },
        list: ["a", "b"]
    });
    assert.deepEqual(out, {
        "@type": "JobPosting",
        Title: "Data Analyst",
        org: { "@type": "Organization", name: "Kentucky" },
        list: ["a", "b"]
    });
});
test("passes through non-string primitives unchanged", () => {
    assert.equal(sanitizeStructured(42), 42);
    assert.equal(sanitizeStructured(true), true);
    assert.equal(sanitizeStructured(null), null);
});

// ---------------------------------------------------------------------------
// stripHtml + sanitizeStructured markup path: need DOMParser
// ---------------------------------------------------------------------------

console.log("stripHtml (needs DOMParser)");
if (typeof DOMParser === "undefined") {
    skip("strips tags and keeps prose", "no DOMParser in plain Node");
    skip("drops style and script text", "no DOMParser in plain Node");
    skip("sanitizeStructured reduces an HTML fragment to text", "no DOMParser in plain Node");
} else {
    test("strips tags and keeps prose", () => {
        assert.equal(stripHtml("<p>Analyze&nbsp;data &amp; report</p>"), "Analyze data & report");
    });
    test("drops style and script text", () => {
        const frag =
            '<div id="x" style="display:none">&nbsp;</div>' +
            "<style>@media (min-width:320px){ .a{ width:100%; } }</style>" +
            "<script>var x=1;</script>" +
            "<p>Real description text.</p>";
        assert.equal(stripHtml(frag), "Real description text.");
    });
    test("sanitizeStructured reduces an HTML fragment to text", () => {
        const out = sanitizeStructured({
            "@type": "JobPosting",
            Description: "<p>Analyze data &amp; report</p><style>.a{}</style>"
        });
        assert.equal(out["@type"], "JobPosting");
        assert.equal(out.Description, "Analyze data & report");
    });
}

// ---------------------------------------------------------------------------
// peelChrome (leading navigation removal)
// ---------------------------------------------------------------------------

console.log("peelChrome");
test("peels a leading nav block that is an exact prefix", () => {
    assert.equal(
        peelChrome(
            "Main Page Talk Read View source Welcome to the encyclopedia.",
            ["Main Page Talk Read View source"]
        ),
        "Welcome to the encyclopedia."
    );
});
test("does not peel a nav phrase that appears mid-page", () => {
    const input = "Real opening sentence. Later a menu Home About Contact appears.";
    assert.equal(peelChrome(input, ["Home About Contact"]), input);
});
test("peels stacked leading blocks in sequence", () => {
    assert.equal(
        peelChrome(
            "Skip to content Primary menu One Two Three Actual body begins here.",
            ["Skip to content", "Primary menu One Two Three"]
        ),
        "Actual body begins here."
    );
});
test("matches across whitespace differences and keeps body spacing", () => {
    assert.equal(peelChrome("Nav   One    Two\n\nBody text starts.", ["Nav One Two"]), "Body text starts.");
});
test("ignores chrome blocks shorter than 8 normalized chars", () => {
    const input = "Go Body content stays intact.";
    assert.equal(peelChrome(input, ["Go"]), input);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed, " + skipped + " skipped");
process.exit(failed ? 1 : 0);
