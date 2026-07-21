/**
 * Full-pipeline tests: the real extractor feeding the real frame picker.
 *
 * The unit suite tests selectBodyFrame with hand-written frame results, and the
 * extractor suite tests pageExtractor on a single frame. Neither exercises the
 * path that actually broke on LinkedIn: real extractor output from several frames
 * handed to selectBodyFrame. This suite closes that gap. It runs the real
 * pageExtractor (through the shared harness) on HTML that stands in for each
 * rendered frame, assembles the injection-result shape captureTab builds, and
 * runs the real selectBodyFrame over it.
 *
 * The frames modelled are the ones that caused or exercise the bug:
 *   - a job posting rendered in the top frame (LinkedIn shape),
 *   - a job posting rendered inside a cross-origin iframe (iCIMS shape),
 *   - a reCAPTCHA anchor frame, whose body is a very long whitespace-free blob,
 *   - an empty client-rendered shell, which is what a captured SPA page yields.
 *
 * The reCAPTCHA blob is representative, not a verbatim capture: any blob has the
 * same two properties that matter here, a huge character length and a tiny word
 * count, so the test does not depend on the exact bytes.
 *
 * Requires jsdom (a dev dependency). Run with:  node test/pipeline.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "./harness.mjs";
import { selectBodyFrame, wordCount, isJunkFrame } from "../src/lib/extract.js";

// ---------------------------------------------------------------------------
// Frame fixtures, each run through the real extractor
// ---------------------------------------------------------------------------

/** A rendered job posting: the content a real frame holds after the page runs. */
const JOB_HTML = `<!DOCTYPE html><html lang="en"><head>
    <title>Senior Business Intelligence Analyst</title>
    <link rel="canonical" href="https://jobs.example.com/postings/bi-analyst">
  </head><body>
    <header><nav>Home Search Saved Jobs Sign in</nav></header>
    <main>
      <h1>Senior Business Intelligence Analyst</h1>
      <p>We are hiring a senior business intelligence analyst to own reporting,
      dashboards, and data models across the organisation. You will partner with
      finance, operations, and product teams to turn raw data into decisions.</p>
      <h2>Responsibilities</h2>
      <p>Build and maintain dashboards in Power BI, write performant SQL against
      the warehouse, design semantic models, and document metric definitions so
      that stakeholders trust the numbers. You will review analyses from other
      analysts and mentor junior members of the team.</p>
      <h2>Qualifications</h2>
      <p>Five years of analytics experience, deep SQL and DAX fluency, and strong
      communication skills. Experience in an academic medical or healthcare
      setting is a plus. Python or R for ad hoc analysis is welcome but not
      required. You should be comfortable working from ambiguous requirements and
      turning them into a concrete, well tested deliverable.</p>
    </main>
    <footer>Equal opportunity employer. Privacy policy. Terms of service.</footer>
  </body></html>`;

/** The reCAPTCHA anchor frame: a long whitespace-free blob rendered as text. */
const RECAPTCHA_BLOB = "recaptcha.anchor.Main.init(\"[" + "A1b2C3d4E5".repeat(3600) + "\");";
const RECAPTCHA_HTML =
    "<!DOCTYPE html><html><head><title>reCAPTCHA</title></head><body>" +
    RECAPTCHA_BLOB +
    "\nRecaptcha requires verification. protected by reCAPTCHA" +
    "</body></html>";

/** A client-rendered shell: an empty landmark plus a bootstrap script. */
const SHELL_HTML = `<!DOCTYPE html><html><head><title>Loading</title></head><body>
    <main id="app"></main>
    <script>window.__boot__ = true; hydrate();</script>
  </body></html>`;

/** A thin outer page that wraps an embedded application (iCIMS shape). */
const OUTER_SHELL_HTML = `<!DOCTYPE html><html><head><title>Careers</title></head><body>
    <header><nav>Careers Home Returning Candidate Sign in</nav></header>
    <div id="icims-frame-mount"></div>
    <footer>Apply Share ICIMS footer</footer>
  </body></html>`;

const JOB_URL = "https://www.linkedin.com/jobs/view/999";
const EMBED_URL = "https://careers-wcu.icims.com/jobs/1234/job";
const OUTER_URL = "https://www.example.edu/careers/senior-bi-analyst";
const RECAPTCHA_URL =
    "https://www.google.com/recaptcha/enterprise/anchor?k=6LcIy&co=aHR0cHM6&size=invisible";
const SHELL_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=1";

/**
 * Build the injection-result shape captureTab assembles: a frameId plus the real
 * extractor output, whose frameUrl the harness sets from the document URL.
 */
function frame(frameId, html, url) {
    return { frameId, result: extract(html, url) };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

test("the reCAPTCHA frame extracts as a huge, near-wordless blob", () => {
    // This is the shape the old character-length picker fell for: enormous bytes,
    // almost no words. The test pins both properties so the regression below is
    // meaningful.
    const f = frame(2, RECAPTCHA_HTML, RECAPTCHA_URL);
    assert.ok(f.result.rawText.length > 20000, "blob should be very long");
    assert.ok(wordCount(f.result.rawText) <= 10, "blob should hold almost no words");
    assert.equal(isJunkFrame(f.result.frameUrl), true);
});

test("the job frame extracts real content with a healthy word count", () => {
    const f = frame(0, JOB_HTML, JOB_URL);
    assert.ok(wordCount(f.result.rawText) > 100);
    assert.ok(f.result.rawText.includes("business intelligence analyst"));
    assert.equal(f.result.lowSignal, false);
    // Header nav sits outside main, so it is not in the content.
    assert.ok(!f.result.rawText.includes("Saved Jobs"));
});

test("the SPA shell extracts as low signal, not as a full page", () => {
    const f = frame(0, SHELL_HTML, SHELL_URL);
    assert.equal(wordCount(f.result.rawText), 0);
    assert.equal(f.result.lowSignal, true);
});

// ---------------------------------------------------------------------------

test("LinkedIn shape: content in the top frame beats a reCAPTCHA subframe", () => {
    const top = frame(0, JOB_HTML, JOB_URL);
    const captcha = frame(2, RECAPTCHA_HTML, RECAPTCHA_URL);
    const picked = selectBodyFrame([top, captcha], top);
    assert.equal(picked, top);
    assert.ok(picked.result.rawText.includes("Responsibilities"));
});

test("iCIMS shape: content in an embedded frame beats a thin top and reCAPTCHA", () => {
    const top = frame(0, OUTER_SHELL_HTML, OUTER_URL);
    const embed = frame(3, JOB_HTML, EMBED_URL);
    const captcha = frame(5, RECAPTCHA_HTML, RECAPTCHA_URL);
    const picked = selectBodyFrame([top, embed, captcha], top);
    assert.equal(picked, embed);
    // Content came from a subframe, so captureTab would record content_frame_url.
    assert.notEqual(picked, top);
    assert.equal(isJunkFrame(picked.result.frameUrl), false);
});

test("belt and suspenders: a junk frame with MORE words than an empty shell still loses", () => {
    // This is the exact regression. The old picker ranked by characters and would
    // have taken reCAPTCHA. Ranking by words alone would still take it here, since
    // the shell has zero words and the blob has a few. Only the URL blocklist
    // saves it, and the honest outcome is the real, low-signal top frame.
    const top = frame(0, SHELL_HTML, SHELL_URL);
    const captcha = frame(2, RECAPTCHA_HTML, RECAPTCHA_URL);
    assert.ok(
        wordCount(captcha.result.rawText) > wordCount(top.result.rawText),
        "precondition: the junk frame has more words than the shell"
    );
    const picked = selectBodyFrame([top, captcha], top);
    assert.equal(picked, top);
    assert.equal(picked.result.lowSignal, true);
});

// ---------------------------------------------------------------------------
