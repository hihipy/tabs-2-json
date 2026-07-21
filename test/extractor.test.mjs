/**
 * Fixture tests for the injected page extractor in src/lib/extractor.js.
 *
 * pageExtractor runs in a page and leans on innerText, which plain Node does not
 * have and jsdom does not implement. The shared harness in test/harness.mjs loads
 * each fixture into jsdom and installs a faithful innerText that drops
 * non-rendered elements (script, style, noscript, template), matching the one
 * property of innerText the extractor depends on.
 *
 * That covers what matters most and is otherwise untested: which content root is
 * chosen (main / article / role=main / density heuristic / body) and whether a
 * leading nav block is peeled. It approximates innerText, so it asserts
 * structural behaviour (right root, nav removed, no script text), not the exact
 * whitespace and visibility semantics a real browser produces.
 *
 * Requires jsdom (a dev dependency). Run with:  node test/extractor.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "./harness.mjs";

const PROSE =
    "This is the real article body. " +
    "It runs well past the two hundred character floor the density heuristic uses, " +
    "so it reads as genuine content rather than boilerplate, with enough length to " +
    "clear the threshold comfortably on any of the fixtures below.";

// ---------------------------------------------------------------------------

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

test("selects a role=main container, reported by its tag not as a landmark", () => {
    // A [role=main] element is chosen, and content_source is that element's tag
    // rather than one of the landmark or fallback keywords. Asserting membership,
    // instead of the literal "div", keeps the test correct if the role's carrier
    // is later a <section> or other element while the behaviour is unchanged.
    const LANDMARK_OR_FALLBACK = new Set(["main", "article", "heuristic", "body"]);
    const r = extract(`<!DOCTYPE html><html><head><title>Aria</title></head><body>
        <header><nav>Home About Contact</nav></header>
        <div role="main"><h1>Aria Title</h1><p>${PROSE}</p></div>
      </body></html>`);
    assert.ok(!LANDMARK_OR_FALLBACK.has(r.contentSource),
        "role=main is reported by tag, not as a landmark or fallback");
    assert.equal(r.contentSource, "div", "the carrier here is a div");
    assert.ok(r.rawText.includes("real article body"));
    assert.ok(!r.rawText.includes("Home About Contact"));
});

test("heuristic penalises a link-heavy block so prose wins", () => {
    // The nav block is longer than the content block by raw length, but it is all
    // link text; the link penalty pushes its score negative and the prose wins.
    const navLinks = '<a href="#">Menu item link</a>'.repeat(20);
    const r = extract(`<!DOCTYPE html><html><head><title>Links</title></head><body>
        <div id="nav">${navLinks}</div>
        <div id="content"><p>${PROSE}</p></div>
      </body></html>`);
    assert.equal(r.contentSource, "heuristic");
    assert.ok(r.rawText.includes("real article body"));
    assert.ok(!r.rawText.includes("Menu item link"));
});

test("falls back to body when no block clears the density bar", () => {
    // Text spread across bare paragraphs with no container block leaves the
    // heuristic no candidate, so the whole body becomes the root.
    const r = extract(`<!DOCTYPE html><html><head><title>Loose</title></head><body>
        <p>${PROSE}</p>
      </body></html>`);
    assert.equal(r.contentSource, "body");
    assert.ok(r.rawText.includes("real article body"));
    assert.equal(r.lowSignal, false);
});

test("reads content from a table-based layout", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Table</title></head><body>
        <table><tbody><tr><td><p>${PROSE}</p></td></tr></tbody></table>
      </body></html>`);
    assert.equal(r.contentSource, "heuristic");
    assert.ok(r.rawText.includes("real article body"));
});

test("does not leak inline script or style text into rawText", () => {
    // A real browser's innerText never returns script or style text. A page whose
    // content root carries an inline script (analytics, widgets) must not have that
    // code counted as content, or a shell page would look full and a real page's
    // word count would be inflated.
    const r = extract(`<!DOCTYPE html><html><head><title>Scripted</title></head><body>
        <main>
          <style>.hidden{display:none}</style>
          <script>var tracker = "should not appear in rawText"; init(tracker);</script>
          <p>${PROSE}</p>
        </main>
      </body></html>`);
    assert.equal(r.contentSource, "main");
    assert.ok(r.rawText.includes("real article body"));
    assert.ok(!r.rawText.includes("should not appear"));
    assert.ok(!r.rawText.includes("display:none"));
});

test("marks a script-only shell as low signal", () => {
    // The static HTML of a client-rendered page is often an empty landmark plus
    // bootstrap scripts. With script text excluded, that must read as low signal
    // rather than as a full page.
    const r = extract(`<!DOCTYPE html><html><head><title>Shell</title></head><body>
        <main>
          <script>window.__DATA__ = ${JSON.stringify(PROSE.repeat(5))};</script>
        </main>
      </body></html>`);
    assert.equal(r.lowSignal, true);
});

test("does not count text hidden with display:none, hidden, or aria-hidden", () => {
    // A real browser's innerText drops text hidden by CSS or the hidden and
    // aria-hidden attributes; textContent would keep it. Hidden boilerplate inside
    // the content root must not inflate the text or defeat the low-signal floor.
    const r = extract(`<!DOCTYPE html><html><head><title>Hidden</title>
        <style>.gone { display: none; }</style>
      </head><body>
        <main>
          <p>${PROSE}</p>
          <p style="display:none">HIDDEN_INLINE boilerplate that should never appear.</p>
          <p class="gone">HIDDEN_CLASS boilerplate that should never appear.</p>
          <div hidden>HIDDEN_ATTR boilerplate that should never appear.</div>
          <div aria-hidden="true">HIDDEN_ARIA boilerplate that should never appear.</div>
        </main>
      </body></html>`);
    assert.equal(r.contentSource, "main");
    assert.ok(r.rawText.includes("real article body"));
    assert.ok(!r.rawText.includes("HIDDEN_INLINE"));
    assert.ok(!r.rawText.includes("HIDDEN_CLASS"));
    assert.ok(!r.rawText.includes("HIDDEN_ATTR"));
    assert.ok(!r.rawText.includes("HIDDEN_ARIA"));
});

test("marks a page as low signal when its only text is hidden", () => {
    // With visibility respected, a landmark whose text is all display:none reads
    // as an empty shell, the same as a client-rendered page that never populated.
    const r = extract(`<!DOCTYPE html><html><head><title>Hidden Shell</title></head><body>
        <main><p style="display:none">${PROSE.repeat(3)}</p></main>
      </body></html>`);
    assert.equal(r.lowSignal, true);
});

// ---------------------------------------------------------------------------

test("resolves site_name, author, published, and the description fallback", () => {
    // No plain description or og:description is present, so description falls
    // through to twitter:description. author and published come from the
    // article:* forms.
    const r = extract(`<!DOCTYPE html><html lang="en-GB"><head>
        <title>Meta</title>
        <meta property="og:site_name" content="Example News">
        <meta property="article:author" content="Jane Doe">
        <meta property="article:published_time" content="2026-07-01">
        <meta name="twitter:description" content="Fallback description.">
      </head><body><main><p>${PROSE}</p></main></body></html>`);
    assert.equal(r.siteName, "Example News");
    assert.equal(r.author, "Jane Doe");
    assert.equal(r.published, "2026-07-01");
    assert.equal(r.description, "Fallback description.");
    assert.equal(r.lang, "en-GB");
});

// ---------------------------------------------------------------------------

test("collects several blocks, dedupes identical ones, spreads arrays", () => {
    const article = '{"@context":"https://schema.org","@type":"Article","headline":"X"}';
    const arrayBlock =
        '[{"@type":"Organization","name":"Acme"},{"@type":"WebSite","name":"Acme.com"}]';
    const r = extract(`<!DOCTYPE html><html><head><title>Multi</title>
        <script type="application/ld+json">${article}</script>
        <script type="application/ld+json">${article}</script>
        <script type="application/ld+json">${arrayBlock}</script>
      </head><body><main><p>${PROSE}</p></main></body></html>`);
    // The duplicate Article is dropped; the array contributes two entries.
    assert.equal(r.structured.length, 3);
    const types = r.structured.map((n) => n["@type"]);
    assert.deepEqual(types, ["Article", "Organization", "WebSite"]);
});

// ---------------------------------------------------------------------------

test("peels both a leading nav and a leading aside", () => {
    const r = extract(`<!DOCTYPE html><html><head><title>Chrome</title></head><body>
        <main>
          <nav>Home About Contact News Careers</nav>
          <aside>Related links sidebar promotional widget content block here</aside>
          <h1>Story Title</h1>
          <p>${PROSE}</p>
        </main>
      </body></html>`);
    const normalized = r.rawText.replace(/\s+/g, " ").trim();
    assert.ok(!normalized.includes("Home About Contact"));
    assert.ok(!normalized.includes("Related links sidebar"));
    assert.ok(r.rawText.includes("real article body"));
});

// ---------------------------------------------------------------------------
