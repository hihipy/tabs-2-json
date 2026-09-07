import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "./harness.mjs";
import {
    selectBodyFrame,
    hasOwnContent,
    wordCount,
    OWN_CONTENT_MIN_WORDS
} from "../src/lib/extract.js";

const frame = (frameId, html, url) => ({ frameId, result: extract(html, url) });

// A careers page that carries the posting itself, with the application form in an
// embedded frame beside it. The form is longer than the posting, which is the
// whole difficulty: its EEO survey and disability questionnaire are boilerplate
// that runs to more words than the job it attaches to.
const POSTING_HTML = `<!DOCTYPE html><html lang="en"><head>
  <title>Data Analyst II | Career Opportunities</title>
  <link rel="canonical" href="https://www.brex.com/careers/8463696002">
  <meta property="og:site_name" content="Brex"></head><body>
  <main><h1>Data Analyst II</h1>
  <p>${"You will build and maintain reporting across the finance organisation. ".repeat(20)}</p>
  </main></body></html>`;

const APPLY_FORM_HTML = `<!DOCTYPE html><html lang="en"><head><title>Apply</title></head><body>
  <main>
  <h2>Apply for this job</h2>
  <p>${"First name last name email phone country location resume cover letter. ".repeat(15)}</p>
  <h2>Voluntary Self-Identification</h2>
  <p>${"For government reporting purposes we ask candidates to respond to this survey. ".repeat(20)}</p>
  <h2>Voluntary Self-Identification of Disability</h2>
  <p>${"A disability is a condition that substantially limits major life activities. ".repeat(25)}</p>
  </main></body></html>`;

const SHELL_HTML = `<!DOCTYPE html><html><head><title>Careers</title></head><body>
  <header><nav>Home Careers Contact</nav></header><div id="embed-host"></div></body></html>`;

const POSTING_URL = "https://www.brex.com/careers/8463696002";
const FORM_URL = "https://job-boards.greenhouse.io/embed/job_app?for=brex";
const SHELL_URL = "https://careers.example.com/openings/42";

test("the longer application form is genuinely longer than the posting", () => {
    // Guards the fixture itself: if this stops holding, the test below stops
    // testing anything, because word count would already pick the right frame.
    const posting = wordCount(extract(POSTING_HTML, POSTING_URL).rawText);
    const form = wordCount(extract(APPLY_FORM_HTML, FORM_URL).rawText);
    assert.ok(form > posting, `form ${form} should exceed posting ${posting}`);
});

test("Brex shape: the posting beats the longer application form beside it", () => {
    const top = frame(0, POSTING_HTML, POSTING_URL);
    const form = frame(3, APPLY_FORM_HTML, FORM_URL);
    assert.equal(selectBodyFrame([top, form], top), top);
});

test("a shell still yields to its embed, whatever the embed contains", () => {
    const top = frame(0, SHELL_HTML, SHELL_URL);
    const form = frame(3, APPLY_FORM_HTML, FORM_URL);
    assert.equal(selectBodyFrame([top, form], top), form);
});

test("hasOwnContent rejects a low-signal frame", () => {
    assert.equal(hasOwnContent(extract(SHELL_HTML, SHELL_URL)), false);
});

test("hasOwnContent accepts a real page", () => {
    assert.equal(hasOwnContent(extract(POSTING_HTML, POSTING_URL)), true);
});

test("hasOwnContent rejects a frame that clears low signal but stays a stub", () => {
    // Long enough to pass the 200-character low-signal floor, still not a page.
    const stub = `<!DOCTYPE html><html><head><title>Jobs</title></head><body><div>
      ${"Home Careers Benefits Culture Contact Search openings Apply now. ".repeat(5)}
      </div></body></html>`;
    const result = extract(stub, SHELL_URL);
    assert.equal(result.lowSignal, false, "fixture must clear the low-signal floor");
    assert.ok(wordCount(result.rawText) < OWN_CONTENT_MIN_WORDS);
    assert.equal(hasOwnContent(result), false);
});

test("hasOwnContent tolerates a missing or malformed result", () => {
    assert.equal(hasOwnContent(null), false);
    assert.equal(hasOwnContent(undefined), false);
    assert.equal(hasOwnContent({}), false);
});
