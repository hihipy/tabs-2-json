/**
 * Fixture tests for the injected page extractor in src/lib/extractor.js.
 *
 * pageExtractor runs in a page and leans on innerText, which plain Node does not
 * have and jsdom does not implement. This harness loads each fixture into jsdom
 * and polyfills innerText as textContent, then runs the real exported function.
 *
 * That covers what matters most and is otherwise untested: which content root is
 * chosen (main / article / role=main / density heuristic / body) and whether a
 * leading nav block is peeled. It approximates innerText with textContent, so it
 * asserts structural behaviour (right root, nav removed), not the exact
 * whitespace and visibility semantics a real browser produces.
 *
 * Requires jsdom (a dev dependency). Run with:  node test/extractor.test.mjs
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { pageExtractor } from "../src/lib/extractor.js";

const LOW_SIGNAL_MIN_CHARS = 200;

// Run the real pageExtractor against an HTML string under jsdom.
function extract(html) {
    const dom = new JSDOM(html);
    // jsdom has no innerText; approximate it with textContent for the run.
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
        get() {
            return this.textContent;
        },
        configurable: true
    });
    const previous = global.document;
    global.document = dom.window.document;
    try {
        return pageExtractor(LOW_SIGNAL_MIN_CHARS);
    } finally {
        global.document = previous;
        dom.window.close();
    }
}

const PROSE =
    "This is the real article body. " +
    "It runs well past the two hundred character floor the density heuristic uses, " +
    "so it reads as genuine content rather than boilerplate, with enough length to " +
    "clear the threshold comfortably on any of the fixtures below.";

let passed = 0;
let failed = 0;

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

// ---------------------------------------------------------------------------
console.log("content root selection");

test("picks <main> and reports content_source main", () => {
    const r = extract(`<!DOCTYPE html><html lang="en"><head>
        <title>Main Fixture</title>
        <link rel="canonical" href="https://example.com/x">
        <meta name="description" content="A description.">
      </head><body>
        <header><nav>Home About Contact</nav></header>
        <main><h1>Real Title</h1><p>${PROSE}</p></main>
        <footer>Site footer links</footer>
      </body></html>`);
    assert.equal(r.contentSource, "main");
    assert.ok(r.rawText.includes("real article body"));
    // nav lives outside main, so it never enters the root text
    assert.ok(!r.rawText.includes("Home About Contact"));
    assert.equal(r.lang, "en");
    assert.equal(r.canonical, "https://example.com/x");
    assert.equal(r.description, "A description.");
    assert.deepEqual(r.headings[0], { level: 1, text: "Real Title" });
});

test("picks <article> when there is no <main>", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>A</title></head><body>
        <article><h1>Headline</h1><p>${PROSE}</p></article>
      </body></html>`);
    assert.equal(r.contentSource, "article");
});

test("falls back to the density heuristic when there is no landmark", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Legacy</title></head><body>
        <div id="nav"><a href="#">Home</a> <a href="#">About</a></div>
        <div id="content"><p>${PROSE}</p></div>
      </body></html>`);
    assert.equal(r.contentSource, "heuristic");
    assert.ok(r.rawText.includes("real article body"));
});

// ---------------------------------------------------------------------------
console.log("leading chrome peel");

test("peels a leading nav that sits inside the content root", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Nav</title></head><body>
        <main>
          <nav>Skip to content Home About Contact News</nav>
          <h1>Story Title</h1>
          <p>${PROSE}</p>
        </main>
      </body></html>`);
    assert.equal(r.contentSource, "main");
    const normalized = r.rawText.replace(/\s+/g, " ").trim();
    // the nav phrase is removed from the front
    assert.ok(!normalized.startsWith("Skip to content"));
    assert.ok(!normalized.includes("Skip to content Home About Contact"));
    // real content survives
    assert.ok(r.rawText.includes("real article body"));
});

test("does not peel a nav phrase that only appears mid-body", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Mid</title></head><body>
        <main><p>Opening sentence of the piece. ${PROSE} Home About Contact.</p></main>
      </body></html>`);
    assert.ok(r.rawText.startsWith("Opening sentence"));
});

// ---------------------------------------------------------------------------
console.log("structured data and flags");

test("collects JSON-LD blocks, flattening arrays", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>SD</title>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Article","headline":"X"}
        </script>
      </head><body><main><p>${PROSE}</p></main></body></html>`);
    assert.equal(r.structured.length, 1);
    assert.equal(r.structured[0]["@type"], "Article");
});

test("ignores malformed JSON-LD without throwing", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Bad</title>
        <script type="application/ld+json">{ not valid json </script>
      </head><body><main><p>${PROSE}</p></main></body></html>`);
    assert.equal(r.structured.length, 0);
    assert.equal(r.contentSource, "main");
});

test("flags a near-empty page as low signal", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Empty</title></head><body>
        <main><p>Too short.</p></main>
      </body></html>`);
    assert.equal(r.lowSignal, true);
});

test("does not flag a full page as low signal", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Full</title></head><body>
        <main><p>${PROSE}</p></main>
      </body></html>`);
    assert.equal(r.lowSignal, false);
});

// ---------------------------------------------------------------------------
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
