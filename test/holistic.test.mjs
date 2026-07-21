/**
 * Holistic tests: the whole capture flow, from rendered frames to finished record.
 *
 * The unit suite tests the pure helpers, the extractor suite tests one frame, and
 * the pipeline suite tests frame selection. This suite tests the contract that
 * ties them together: buildRecord, the function captureTab calls once it has the
 * injected frame results. It runs the real pageExtractor (through the shared
 * harness) on HTML that stands in for each rendered frame, assembles the
 * {frameId, result} shape captureTab builds, and runs the real buildRecord over
 * it with real settings. Assertions cover the full output record: which frame
 * wins, tab identity, metadata fallback from top to body, content_frame_url,
 * video handling, text shaping, structured-data sanitisation, the settings
 * toggles, and pruning.
 *
 * sanitizeStructured strips HTML from JSON-LD values with DOMParser, which jsdom
 * provides but plain Node does not, so the suite installs a global DOMParser.
 *
 * Requires jsdom (a dev dependency). Run with:  node test/holistic.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { extract } from "./harness.mjs";
import { buildRecord, DEFAULT_SETTINGS } from "../src/lib/extract.js";

// sanitizeStructured uses new DOMParser(); give it a real one.
global.DOMParser = new JSDOM().window.DOMParser;

/** Settings for a case: real defaults with per-case overrides. */
function withSettings(overrides) {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Assemble the injection-result shape captureTab builds for one frame. */
function frame(frameId, html, url) {
    return { frameId, result: extract(html, url) };
}

const AT = "2026-07-21T04:12:58.000Z";

// ---------------------------------------------------------------------------
// Frame fixtures
// ---------------------------------------------------------------------------

/** A full job posting: real content, complete metadata, JobPosting JSON-LD. */
const JOB_HTML = `<!DOCTYPE html><html lang="en"><head>
    <title>Senior BI Analyst</title>
    <link rel="canonical" href="https://jobs.example.com/bi-analyst?ref=nav">
    <meta property="og:site_name" content="Example Jobs">
    <meta name="description" content="Own reporting and dashboards.">
    <meta name="author" content="Example Talent">
    <meta property="article:published_time" content="2026-06-01">
    <script type="application/ld+json">{"@context":"https://schema.org",
      "@type":"JobPosting","title":"Senior BI Analyst",
      "description":"<p>Build dashboards &amp; own <b>SQL</b> models.</p>"}</script>
  </head><body>
    <header><nav>Home Search Saved Sign in</nav></header>
    <main>
      <h1>Senior Business Intelligence Analyst</h1>
      <p>We are hiring a senior business intelligence analyst to own reporting,
      dashboards, and data models across the organisation. You will partner with
      finance, operations, and product teams to turn raw data into decisions and
      to document the metric definitions that everyone else relies on.</p>
      <p>Five years of analytics experience, deep SQL and DAX fluency, and clear
      writing. Experience in an academic medical setting is a plus. You should be
      comfortable turning ambiguous requirements into a tested deliverable.</p>
    </main>
  </body></html>`;

/** The reCAPTCHA anchor frame: a long whitespace-free blob rendered as text. */
const RECAPTCHA_BLOB = "recaptcha.anchor.Main.init(\"[" + "A1b2C3d4E5".repeat(3600) + "\");";
const RECAPTCHA_HTML =
    "<!DOCTYPE html><html><head><title>reCAPTCHA</title></head><body>" +
    RECAPTCHA_BLOB +
    "\nRecaptcha requires verification. protected by reCAPTCHA</body></html>";

/** A thin outer page that wraps an embedded application (iCIMS shape). */
const OUTER_SHELL_HTML = `<!DOCTYPE html><html><head><title>Careers</title></head><body>
    <header><nav>Careers Home Returning Candidate Sign in</nav></header>
    <div id="icims-mount"></div>
  </body></html>`;

/** A top frame with prose but no metadata, to drive the fallback to the body. */
const TOP_NOMETA_HTML = `<!DOCTYPE html><html><head><title>Shell</title></head><body>
    <main><p>A short top-frame notice with a little text and nothing else of
    substance to report here at all.</p></main>
  </body></html>`;

/** A richer sub-frame that carries the metadata the top frame lacks. */
const SUB_META_HTML = `<!DOCTYPE html><html lang="es"><head>
    <title>Puesto</title>
    <meta property="og:site_name" content="Portal de Empleo">
    <meta name="description" content="Analista de inteligencia de negocios.">
  </head><body>
    <main>
      <h1>Analista Senior</h1>
      <p>Buscamos un analista senior para liderar los informes y los tableros de
      la organizacion, trabajando con finanzas y operaciones para convertir los
      datos en decisiones y documentar las definiciones de cada metrica que el
      resto del equipo utiliza a diario en su trabajo.</p>
    </main>
  </body></html>`;

/** A video-only page: a VideoObject and enough body text to force a trim. */
const VIDEO_HTML = `<!DOCTYPE html><html><head><title>The Video</title>
    <script type="application/ld+json">{"@context":"https://schema.org",
      "@type":"VideoObject","name":"The Video","description":"A demo clip."}</script>
  </head><body>
    <main><p>${"This is filler describing the video and its channel. ".repeat(12)}</p></main>
  </body></html>`;

const JOB_URL = "https://www.linkedin.com/jobs/view/999?trk=abc";
const EMBED_URL = "https://careers-wcu.icims.com/jobs/1234/job?mode=job&iis=nav";
const OUTER_URL = "https://www.example.edu/careers/senior-bi-analyst";
const SUB_URL = "https://embed.example.com/posting/42";
const RECAPTCHA_URL = "https://www.google.com/recaptcha/enterprise/anchor?k=6Lc&co=aHR";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

test("LinkedIn shape: real content, no content_frame_url, clean record", () => {
    const frames = [frame(0, JOB_HTML, JOB_URL), frame(2, RECAPTCHA_HTML, RECAPTCHA_URL)];
    const r = buildRecord({ id: 7, title: "data analyst Jobs | LinkedIn", url: JOB_URL },
        frames, withSettings({}), AT);
    assert.equal(r.ok, true);
    assert.equal(r.id, 7);
    assert.ok(r.word_count > 80, "should have a healthy word count");
    assert.ok(r.text.includes("business intelligence analyst"));
    assert.ok(!("content_frame_url" in r), "top-frame body sets no content_frame_url");
    assert.ok(!("low_signal" in r), "a full page is not low signal");
    assert.ok(!("content_type" in r), "non-video pages prune content_type");
    assert.equal(r.captured_at, AT);
});

test("iCIMS shape: embedded frame wins and records its content_frame_url", () => {
    const frames = [
        frame(0, OUTER_SHELL_HTML, OUTER_URL),
        frame(3, JOB_HTML, EMBED_URL),
        frame(5, RECAPTCHA_HTML, RECAPTCHA_URL)
    ];
    const r = buildRecord({ id: 1, title: "Careers", url: OUTER_URL }, frames, withSettings({}), AT);
    assert.equal(r.url, OUTER_URL, "tab url stays the top-frame url");
    assert.ok(r.content_frame_url.startsWith("https://careers-wcu.icims.com/jobs/1234/job"));
    assert.ok(r.text.includes("business intelligence analyst"));
});

test("metadata falls back from the top frame to the body frame", () => {
    // Top frame (id 0) has no metadata; the richer sub-frame does and wins the body.
    const frames = [frame(0, TOP_NOMETA_HTML, OUTER_URL), frame(3, SUB_META_HTML, SUB_URL)];
    const r = buildRecord({ id: 2, title: "", url: OUTER_URL }, frames, withSettings({}), AT);
    assert.equal(r.site_name, "Portal de Empleo");
    assert.equal(r.description, "Analista de inteligencia de negocios.");
    assert.equal(r.language, "es");
    assert.equal(r.content_frame_url, SUB_URL);
});

test("video-only: content_type video, low signal, text trimmed to a snippet", () => {
    const frames = [frame(0, VIDEO_HTML, VIDEO_URL)];
    const r = buildRecord({ id: 3, title: "The Video", url: VIDEO_URL }, frames, withSettings({}), AT);
    assert.equal(r.content_type, "video");
    assert.equal(r.low_signal, true);
    assert.ok(r.text.length <= 300, "video text is trimmed to the snippet cap");
    assert.equal(r.text_truncated, true);
    const types = r.structured_data.flatMap((b) => (b && b["@type"] ? [b["@type"]] : []));
    assert.ok(types.includes("VideoObject"));
});

test("maxTextChars caps the text and flags truncation", () => {
    const frames = [frame(0, JOB_HTML, JOB_URL)];
    const r = buildRecord({ id: 4, title: "Job", url: JOB_URL }, frames,
        withSettings({ maxTextChars: 60 }), AT);
    assert.ok(r.text.length <= 60);
    assert.equal(r.text_truncated, true);
    assert.equal(r.word_count, r.text.split(/\s+/).filter(Boolean).length);
});

test("JSON-LD HTML in a JobPosting description is stripped to plain text", () => {
    const frames = [frame(0, JOB_HTML, JOB_URL)];
    const r = buildRecord({ id: 5, title: "Job", url: JOB_URL }, frames, withSettings({}), AT);
    const job = r.structured_data.find((b) => b && b["@type"] === "JobPosting");
    assert.ok(job, "JobPosting block present");
    assert.ok(!/[<>]/.test(job.description), "tags removed");
    assert.ok(job.description.includes("Build dashboards & own SQL models"));
});

test("settings toggles omit text, structured data, and headings", () => {
    const frames = [frame(0, JOB_HTML, JOB_URL)];
    const r = buildRecord({ id: 6, title: "Job", url: JOB_URL }, frames,
        withSettings({ includeText: false, includeStructuredData: false, includeHeadings: false }), AT);
    assert.ok(!("text" in r) && !("word_count" in r));
    assert.ok(!("structured_data" in r));
    assert.ok(!("headings" in r));
    assert.equal(r.content_source, "main", "core fields still present");
});

test("prune drops metadata the page did not provide", () => {
    const frames = [frame(0, TOP_NOMETA_HTML, OUTER_URL)];
    const r = buildRecord({ id: 8, title: "Shell", url: OUTER_URL }, frames, withSettings({}), AT);
    for (const key of ["site_name", "description", "author", "published_at", "canonical_url"]) {
        assert.ok(!(key in r), key + " should be pruned when absent");
    }
    assert.equal(r.ok, true);
});

test("stripUrlParams strips the query from url and content_frame_url", () => {
    const frames = [frame(0, OUTER_SHELL_HTML, OUTER_URL), frame(3, JOB_HTML, EMBED_URL)];
    const r = buildRecord({ id: 9, title: "Careers", url: JOB_URL }, frames,
        withSettings({ stripUrlParams: true }), AT);
    assert.ok(!r.url.includes("?"), "tab url query stripped");
    assert.ok(!r.content_frame_url.includes("?"), "content_frame_url query stripped");
});

// ---------------------------------------------------------------------------
