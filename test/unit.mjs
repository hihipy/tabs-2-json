/**
 * Unit tests for the shared pure logic in src/lib/extract.js.
 *
 * These import the real module, so they exercise the code the extension ships
 * rather than a copy. Run with:  node test/unit.mjs
 *
 * stripHtml and the markup path of sanitizeStructured need a DOMParser, which
 * exists in the browser and under jsdom but not in plain Node, so those checks
 * run only when DOMParser is present and are skipped, not failed, otherwise.
 *
 * The logic inside pageExtractor (content-root scoring, the leading-chrome peel,
 * metadata reads) is not covered here: that function is injected into the page
 * and cannot be imported. Testing it would need a browser or jsdom harness that
 * runs the injected function against a fixture DOM.
 */

import assert from "node:assert/strict";
import {
    DEFAULT_SETTINGS,
    isScriptable,
    hostOf,
    isBlocked,
    outputUrl,
    collectTypes,
    schemaTypes,
    isVideoOnly,
    cleanText,
    prune,
    stripHtml,
    sanitizeStructured,
    timestampName,
    clampInt,
    parseDomains
} from "../src/lib/extract.js";

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
console.log("DEFAULT_SETTINGS");
test("has the expected keys and safe defaults", () => {
    assert.equal(DEFAULT_SETTINGS.stripUrlParams, false);
    assert.equal(DEFAULT_SETTINGS.maxTextChars, 0);
    assert.deepEqual(DEFAULT_SETTINGS.blockedDomains, []);
});

// ---------------------------------------------------------------------------
console.log("isScriptable");
test("accepts http and https", () => {
    assert.equal(isScriptable("https://example.com"), true);
    assert.equal(isScriptable("http://example.com"), true);
});
test("rejects file, chrome, and empty urls", () => {
    assert.equal(isScriptable("file:///Users/me/page.html"), false);
    assert.equal(isScriptable("chrome://extensions"), false);
    assert.equal(isScriptable(""), false);
    assert.equal(isScriptable(null), false);
});

// ---------------------------------------------------------------------------
console.log("hostOf");
test("lowercases the hostname and ignores path and query", () => {
    assert.equal(hostOf("https://Example.COM/a?b=1"), "example.com");
});
test("returns empty string for an unparseable url", () => {
    assert.equal(hostOf("not a url"), "");
});

// ---------------------------------------------------------------------------
console.log("isBlocked");
test("matches an exact host and a subdomain", () => {
    assert.equal(isBlocked("https://mybank.com/login", ["mybank.com"]), true);
    assert.equal(isBlocked("https://secure.mybank.com/x", ["mybank.com"]), true);
});
test("does not match an unrelated or superstring host", () => {
    assert.equal(isBlocked("https://example.com", ["mybank.com"]), false);
    assert.equal(isBlocked("https://notmybank.com", ["mybank.com"]), false);
});
test("tolerates an empty or missing block list", () => {
    assert.equal(isBlocked("https://example.com", []), false);
    assert.equal(isBlocked("https://example.com", undefined), false);
});

// ---------------------------------------------------------------------------
console.log("outputUrl");
test("strips query and fragment when enabled", () => {
    assert.equal(
        outputUrl("https://www.youtube.com/watch?v=abc#t=10", true),
        "https://www.youtube.com/watch"
    );
});
test("leaves the url intact when disabled", () => {
    assert.equal(
        outputUrl("https://www.youtube.com/watch?v=abc", false),
        "https://www.youtube.com/watch?v=abc"
    );
});
test("returns the input unchanged when it is not a url", () => {
    assert.equal(outputUrl("not a url", true), "not a url");
});

// ---------------------------------------------------------------------------
console.log("collectTypes / schemaTypes");
test("collects @type across arrays and @graph", () => {
    const acc = new Set();
    collectTypes({ "@graph": [{ "@type": "Article" }, { "@type": ["VideoObject", "Thing"] }] }, acc);
    assert.deepEqual([...acc].sort(), ["Article", "Thing", "VideoObject"]);
});
test("schemaTypes flattens a list of blocks", () => {
    const types = schemaTypes([{ "@type": "JobPosting" }, { "@type": "Organization" }]);
    assert.equal(types.has("JobPosting"), true);
    assert.equal(types.has("Organization"), true);
});

// ---------------------------------------------------------------------------
console.log("isVideoOnly");
test("true for a VideoObject with no article type", () => {
    assert.equal(isVideoOnly([{ "@type": "VideoObject" }]), true);
});
test("false when an article type is also present", () => {
    assert.equal(isVideoOnly([{ "@type": "VideoObject" }, { "@type": "NewsArticle" }]), false);
});
test("false when there is no video", () => {
    assert.equal(isVideoOnly([{ "@type": "WebPage" }]), false);
    assert.equal(isVideoOnly([]), false);
});

// ---------------------------------------------------------------------------
console.log("cleanText");
test("trims each line and drops carriage returns", () => {
    assert.equal(cleanText("  a \r\n  b  "), "a\nb");
});
test("collapses 3 or more blank lines to one", () => {
    assert.equal(cleanText("a\n\n\n\n\nb"), "a\n\nb");
});
test("returns empty string for null input", () => {
    assert.equal(cleanText(null), "");
});

// ---------------------------------------------------------------------------
console.log("prune");
test("drops null, undefined, empty string, and empty array", () => {
    assert.deepEqual(prune({ a: null, b: undefined, c: "", d: [], e: "keep" }), { e: "keep" });
});
test("keeps boolean false and the number zero", () => {
    assert.deepEqual(prune({ flag: false, n: 0 }), { flag: false, n: 0 });
});

// ---------------------------------------------------------------------------
console.log("timestampName");
test("matches the tabs2json-<iso>.json shape with no colons", () => {
    assert.match(timestampName(), /^tabs2json-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
});

// ---------------------------------------------------------------------------
console.log("clampInt");
test("clamps below the minimum and rejects non-numbers", () => {
    assert.equal(clampInt("-5", 0), 0);
    assert.equal(clampInt("abc", 0), 0);
    assert.equal(clampInt("2500", 0), 2500);
});

// ---------------------------------------------------------------------------
console.log("parseDomains");
test("splits on newlines and commas, lowercases, dedupes", () => {
    assert.deepEqual(parseDomains("A.com\nb.com, A.com"), ["a.com", "b.com"]);
});
test("strips scheme and path from pasted urls", () => {
    assert.deepEqual(parseDomains("https://mybank.com/login"), ["mybank.com"]);
});
test("returns an empty array for blank input", () => {
    assert.deepEqual(parseDomains(""), []);
    assert.deepEqual(parseDomains(null), []);
});

// ---------------------------------------------------------------------------
console.log("sanitizeStructured (structure, no DOMParser needed)");
test("leaves plain strings, bare <, and urls untouched", () => {
    assert.equal(sanitizeStructured("Frankfort, KY"), "Frankfort, KY");
    assert.equal(sanitizeStructured("a < b and c > d"), "a < b and c > d");
    assert.equal(sanitizeStructured("https://x.com/a?b=1&c=2"), "https://x.com/a?b=1&c=2");
});
test("recurses arrays and objects, preserving @type", () => {
    const out = sanitizeStructured({
        "@type": "JobPosting",
        org: { "@type": "Organization", name: "Kentucky" },
        list: ["a", "b"]
    });
    assert.deepEqual(out, {
        "@type": "JobPosting",
        org: { "@type": "Organization", name: "Kentucky" },
        list: ["a", "b"]
    });
});

// ---------------------------------------------------------------------------
console.log("stripHtml (needs DOMParser)");
if (typeof DOMParser === "undefined") {
    skip("strips tags and keeps prose", "no DOMParser in plain Node");
    skip("drops style and script text", "no DOMParser in plain Node");
    skip("sanitizeStructured reduces an HTML fragment", "no DOMParser in plain Node");
} else {
    test("strips tags and keeps prose", () => {
        assert.equal(stripHtml("<p>Analyze&nbsp;data &amp; report</p>"), "Analyze data & report");
    });
    test("drops style and script text", () => {
        const frag =
            '<div style="display:none">&nbsp;</div>' +
            "<style>@media (min-width:320px){ .a{ width:100%; } }</style>" +
            "<script>var x=1;</script>" +
            "<p>Real description text.</p>";
        assert.equal(stripHtml(frag), "Real description text.");
    });
    test("sanitizeStructured reduces an HTML fragment", () => {
        const out = sanitizeStructured({
            "@type": "JobPosting",
            Description: "<p>Analyze data &amp; report</p><style>.a{}</style>"
        });
        assert.equal(out["@type"], "JobPosting");
        assert.equal(out.Description, "Analyze data & report");
    });
}

// ---------------------------------------------------------------------------
console.log("\n" + passed + " passed, " + failed + " failed, " + skipped + " skipped");
process.exit(failed ? 1 : 0);
