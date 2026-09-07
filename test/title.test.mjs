import assert from "node:assert/strict";
import { test } from "node:test";
import {
    primaryHeading,
    preferPageHeading,
    buildRecord,
    DEFAULT_SETTINGS
} from "../src/lib/extract.js";
import { extract } from "./harness.mjs";

const AT = "2026-09-04T23:12:10.451Z";
const withSettings = (o) => ({ ...DEFAULT_SETTINGS, ...o });
const frame = (frameId, html, url) => ({ frameId, result: extract(html, url) });

// ---------------------------------------------------------------------------
// primaryHeading
// ---------------------------------------------------------------------------

test("primaryHeading takes a lone heading at the shallowest level", () => {
    assert.equal(primaryHeading([{ level: 2, text: "Sr. Financial Analyst" }]),
        "Sr. Financial Analyst");
    assert.equal(primaryHeading([
        { level: 1, text: "The Job" },
        { level: 2, text: "Responsibilities" },
        { level: 2, text: "Benefits" }
    ]), "The Job");
});

test("primaryHeading declines when the shallowest level repeats", () => {
    // The Greenhouse application form: three h2 section labels, no page title.
    assert.equal(primaryHeading([
        { level: 2, text: "Apply for this job" },
        { level: 2, text: "Voluntary Self-Identification" },
        { level: 2, text: "Voluntary Self-Identification of Disability" }
    ]), "");
});

test("primaryHeading tolerates empty and malformed input", () => {
    assert.equal(primaryHeading([]), "");
    assert.equal(primaryHeading(null), "");
    assert.equal(primaryHeading(undefined), "");
    assert.equal(primaryHeading([{ text: "no level" }]), "");
    assert.equal(primaryHeading([{ level: 1 }]), "");
});

// ---------------------------------------------------------------------------
// preferPageHeading
// ---------------------------------------------------------------------------

test("preferPageHeading takes the heading when the two describe different things", () => {
    assert.equal(
        preferPageHeading("Career Center | Recruitment", "Sr. Financial Analyst"),
        true
    );
});

test("preferPageHeading keeps a tab title that already contains the heading", () => {
    assert.equal(preferPageHeading("Sr. Financial Analyst | ADP", "Sr. Financial Analyst"), false);
    assert.equal(preferPageHeading("Analyst", "Analyst - Remote, US"), false);
});

test("preferPageHeading ignores case and whitespace when comparing", () => {
    assert.equal(preferPageHeading("SR. FINANCIAL   ANALYST", "Sr. Financial Analyst"), false);
});

test("preferPageHeading needs a heading, and takes one when there is no title", () => {
    assert.equal(preferPageHeading("Anything", ""), false);
    assert.equal(preferPageHeading("Anything", "   "), false);
    assert.equal(preferPageHeading("", "The Job"), true);
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

const ADP_HTML = `<!DOCTYPE html><html lang="en-us"><head>
  <title>Career Center | Recruitment</title></head><body>
  <div><h2>Sr. Financial Analyst - Data, Digital &amp; Marketing Analytics</h2>
  <p>${"Own weekly reporting of digital sales results versus forecast. ".repeat(12)}</p>
  </div></body></html>`;

const ADP_URL = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=953437";

test("the SPA router title loses to the posting's own heading", () => {
    const frames = [frame(0, ADP_HTML, ADP_URL)];
    const r = buildRecord(
        { id: 1, title: "Career Center | Recruitment", url: ADP_URL },
        frames, withSettings({}), AT
    );
    assert.equal(r.title, "Sr. Financial Analyst - Data, Digital & Marketing Analytics");
    assert.equal(r.tab_title, "Career Center | Recruitment", "the tab title is kept, not discarded");
});

const FORM_HTML = `<!DOCTYPE html><html lang="en"><head><title>Data Analyst II | Careers</title>
  </head><body><div>
  <h2>Apply for this job</h2><p>${"First name last name email phone. ".repeat(10)}</p>
  <h2>Voluntary Self-Identification</h2><p>${"Gender race ethnicity veteran status. ".repeat(10)}</p>
  <h2>Voluntary Self-Identification of Disability</h2><p>${"Form CC-305 OMB control number. ".repeat(10)}</p>
  </div></body></html>`;

test("a form's section labels do not become the record title", () => {
    const frames = [frame(0, FORM_HTML, "https://example.com/careers/1")];
    const r = buildRecord(
        { id: 2, title: "Data Analyst II | Careers", url: "https://example.com/careers/1" },
        frames, withSettings({}), AT
    );
    assert.equal(r.title, "Data Analyst II | Careers");
    assert.ok(!("tab_title" in r), "no override means no second title field");
});

const PLAIN_HTML = `<!DOCTYPE html><html lang="en"><head><title>Widgets Inc - About Us</title>
  </head><body><main><h1>About Us</h1>
  <p>${"We have made widgets since 1994 in a small town. ".repeat(12)}</p></main></body></html>`;

test("an ordinary page keeps its tab title when the heading is contained in it", () => {
    const frames = [frame(0, PLAIN_HTML, "https://widgets.example/about")];
    const r = buildRecord(
        { id: 3, title: "Widgets Inc - About Us", url: "https://widgets.example/about" },
        frames, withSettings({}), AT
    );
    assert.equal(r.title, "Widgets Inc - About Us");
    assert.ok(!("tab_title" in r));
});

test("headings turned off still resolves a title from the page", () => {
    const frames = [frame(0, ADP_HTML, ADP_URL)];
    const r = buildRecord(
        { id: 4, title: "Career Center | Recruitment", url: ADP_URL },
        frames, withSettings({ includeHeadings: false }), AT
    );
    assert.equal(r.title, "Sr. Financial Analyst - Data, Digital & Marketing Analytics");
    assert.ok(!("headings" in r), "the setting still omits the headings array");
});

// ---------------------------------------------------------------------------
// Section labels
// ---------------------------------------------------------------------------

test("a lone section label does not displace a good tab title", () => {
    // Workable heads the posting body with an h2 reading "Description" and puts
    // the job title in the document title, which inverts the ADP case.
    const html = `<!DOCTYPE html><html lang="en"><head>
      <title>Data Engineer, Customer Engineering - Claritas Rx</title></head><body>
      <main><h2>Description</h2>
      <h3>Who We Are</h3><p>${"We build software for rare disease brands. ".repeat(12)}</p>
      <h3>The Position</h3><p>${"You will own the data pipeline end to end. ".repeat(12)}</p>
      </main></body></html>`;
    const frames = [frame(0, html, "https://apply.workable.com/claritasrx/j/F867AF1B36/")];
    const r = buildRecord(
        { id: 10, title: "Data Engineer, Customer Engineering - Claritas Rx",
          url: "https://apply.workable.com/claritasrx/j/F867AF1B36/" },
        frames, withSettings({}), AT
    );
    assert.equal(r.title, "Data Engineer, Customer Engineering - Claritas Rx");
    assert.ok(!("tab_title" in r), "no override, so no second title field");
});

test("preferPageHeading rejects the section labels an ATS uses", () => {
    for (const label of ["Description", "Job Description", "Overview", "Summary",
                         "About the Role", "Responsibilities", "Apply for this job",
                         "Careers", "Details"]) {
        assert.equal(preferPageHeading("Real Job Title - Company", label), false, label);
    }
});

test("preferPageHeading rejects a one-word heading", () => {
    assert.equal(preferPageHeading("Something Else Entirely", "Positions"), false);
    assert.equal(preferPageHeading("Something Else Entirely", "Jobs"), false);
});

test("preferPageHeading still takes a real multi-word title", () => {
    assert.equal(
        preferPageHeading("Career Center | Recruitment", "Sr. Financial Analyst"),
        true
    );
    assert.equal(preferPageHeading("Careers | Brex", "Data Analyst II"), true);
});
