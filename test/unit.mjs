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
import { test } from "node:test";
import {
    DEFAULT_SETTINGS,
    isScriptable,
    hostOf,
    isBlocked,
    outputUrl,
    isJunkFrame,
    wordCount,
    selectBodyFrame,
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

// Skipped checks use node:test's skip option so they report as skipped, not passed.
function skip(name, reason) {
    test(name, { skip: reason }, () => {});
}


// ---------------------------------------------------------------------------
test("has the expected keys and safe defaults", () => {
    assert.equal(DEFAULT_SETTINGS.stripUrlParams, false);
    assert.equal(DEFAULT_SETTINGS.maxTextChars, 0);
    assert.deepEqual(DEFAULT_SETTINGS.blockedDomains, []);
});

// ---------------------------------------------------------------------------
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
test("lowercases the hostname and ignores path and query", () => {
    assert.equal(hostOf("https://Example.COM/a?b=1"), "example.com");
});
test("returns empty string for an unparseable url", () => {
    assert.equal(hostOf("not a url"), "");
});

// ---------------------------------------------------------------------------
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
test("flags reCAPTCHA by host and by google.com path", () => {
    assert.equal(
        isJunkFrame("https://www.google.com/recaptcha/enterprise/anchor?k=abc"),
        true
    );
    assert.equal(isJunkFrame("https://www.recaptcha.net/recaptcha/api2/anchor"), true);
    assert.equal(isJunkFrame("https://newassets.hcaptcha.com/captcha/v1/x"), true);
});
test("flags ad, analytics, consent, and chat frames", () => {
    assert.equal(isJunkFrame("https://tpc.googlesyndication.com/safeframe/x"), true);
    assert.equal(isJunkFrame("https://www.google-analytics.com/g/collect"), true);
    assert.equal(isJunkFrame("https://cdn.cookielaw.org/consent/x"), true);
    assert.equal(isJunkFrame("https://widget.intercom.io/widget/abc"), true);
    assert.equal(isJunkFrame("https://www.facebook.com/plugins/like.php"), true);
});
test("does not flag ordinary content frames on shared hosts", () => {
    assert.equal(isJunkFrame("https://www.google.com/search?q=data"), false);
    assert.equal(isJunkFrame("https://www.facebook.com/some/profile"), false);
    assert.equal(isJunkFrame("https://careers-wcu.icims.com/jobs/1234/job"), false);
    assert.equal(isJunkFrame("https://www.linkedin.com/jobs/view/999"), false);
});
test("returns false for an unparseable or empty url", () => {
    assert.equal(isJunkFrame(""), false);
    assert.equal(isJunkFrame(null), false);
    assert.equal(isJunkFrame("not a url"), false);
});

// ---------------------------------------------------------------------------
test("counts whitespace-delimited words and ignores edges", () => {
    assert.equal(wordCount("  the quick  brown fox "), 4);
    assert.equal(wordCount("one"), 1);
    assert.equal(wordCount(""), 0);
    assert.equal(wordCount(null), 0);
});
test("scores a whitespace-free blob near nothing", () => {
    // A base64-style payload with no spaces is a single token, however long.
    assert.equal(wordCount("A".repeat(50000)), 1);
});

// ---------------------------------------------------------------------------
test("prefers the sub-frame with the most words (iCIMS-style embed)", () => {
    const top = { frameId: 0, result: { frameUrl: "https://jobs.example.com/", rawText: "Apply here" } };
    const embed = {
        frameId: 3,
        result: {
            frameUrl: "https://careers.icims.com/jobs/1/x",
            rawText: "Senior analyst role with many detailed responsibilities and duties listed here"
        }
    };
    assert.equal(selectBodyFrame([top, embed], top), embed);
});
test("excludes a huge reCAPTCHA frame so the top content frame wins", () => {
    // Mirrors the LinkedIn failure: the recaptcha frame's char length dwarfs the
    // page, but it is one whitespace-free token, and it is a junk host besides.
    const top = {
        frameId: 0,
        result: {
            frameUrl: "https://www.linkedin.com/jobs/search-results/?x=1",
            rawText: "Data Analyst II SQL Developer OpenLoop full time remote role responsibilities and requirements"
        }
    };
    const captcha = {
        frameId: 2,
        result: {
            frameUrl: "https://www.google.com/recaptcha/enterprise/anchor?k=abc",
            rawText: 'recaptcha.anchor.Main.init("' + "x".repeat(40000) + '");'
        }
    };
    assert.equal(selectBodyFrame([top, captcha], top), top);
});
test("falls back to the top frame when every sub-frame is junk", () => {
    const top = { frameId: 0, result: { frameUrl: "https://site.com/", rawText: "thin shell" } };
    const ad = { frameId: 1, result: { frameUrl: "https://adnxs.com/x", rawText: "buy now ".repeat(200) } };
    assert.equal(selectBodyFrame([top, ad], top), top);
});
test("keeps the top frame on a word-count tie", () => {
    const top = { frameId: 0, result: { frameUrl: "https://site.com/", rawText: "one two three" } };
    const other = { frameId: 5, result: { frameUrl: "https://embed.site.com/x", rawText: "four five six" } };
    assert.equal(selectBodyFrame([top, other], top), top);
});

// ---------------------------------------------------------------------------
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
test("drops null, undefined, empty string, and empty array", () => {
    assert.deepEqual(prune({ a: null, b: undefined, c: "", d: [], e: "keep" }), { e: "keep" });
});
test("keeps boolean false and the number zero", () => {
    assert.deepEqual(prune({ flag: false, n: 0 }), { flag: false, n: 0 });
});

// ---------------------------------------------------------------------------
test("matches the tabs2json-<iso>.json shape with no colons", () => {
    assert.match(timestampName(), /^tabs2json-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
});

// ---------------------------------------------------------------------------
test("clamps below the minimum and rejects non-numbers", () => {
    assert.equal(clampInt("-5", 0), 0);
    assert.equal(clampInt("abc", 0), 0);
    assert.equal(clampInt("2500", 0), 2500);
});

// ---------------------------------------------------------------------------
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
