/**
 * Capture orchestration tests for the pure helpers in src/lib/extract.js that
 * popup.js wires to the browser: withTimeout, readWithFallback, captureAll, and
 * failureNote. These carry the logic behind the export flow, the per-tab timeout,
 * the slow-sub-frame fallback, the live progress count, and the failure summary,
 * none of which could be tested while it lived inside captureTab.
 *
 * The timing tests use short real timers with promises that resolve fast or never
 * settle, so they exercise the race paths deterministically without fake clocks.
 * No jsdom is needed; these run on plain Node.
 *
 * Run with:  node --test test/capture.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    withTimeout,
    readWithFallback,
    captureAll,
    failureNote,
    guardConcurrent
} from "../src/lib/extract.js";

/** A promise that never settles, for exercising timeout paths. */
function never() {
    return new Promise(() => {});
}

/** A promise that resolves to value after ms. */
function after(ms, value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ---------------------------------------------------------------------------
// withTimeout

test("withTimeout resolves with the value when the promise wins", async () => {
    const value = await withTimeout(Promise.resolve(42), 50, "too slow");
    assert.equal(value, 42);
});

test("withTimeout resolves when the promise beats the deadline", async () => {
    const value = await withTimeout(after(5, "quick"), 50, "too slow");
    assert.equal(value, "quick");
});

test("withTimeout rejects with the message when the timeout wins", async () => {
    await assert.rejects(
        () => withTimeout(never(), 10, "timed out here"),
        (err) => err.message === "timed out here"
    );
});

// ---------------------------------------------------------------------------
// readWithFallback

test("readWithFallback returns the all-frames read and skips the fallback", async () => {
    let topCalled = false;
    const result = await readWithFallback(
        () => Promise.resolve(["all-frames"]),
        () => {
            topCalled = true;
            return Promise.resolve(["top"]);
        },
        50,
        200,
        "cap"
    );
    assert.deepEqual(result, ["all-frames"]);
    assert.equal(topCalled, false, "top-frame read must not run when all-frames succeeds");
});

test("readWithFallback falls back to the top frame when sub-frames are slow", async () => {
    // The all-frames read never settles (a stuck embedded frame); after the
    // sub-frame budget the top-frame read supplies the content.
    const result = await readWithFallback(
        () => never(),
        () => Promise.resolve(["top-only"]),
        10,
        200,
        "cap"
    );
    assert.deepEqual(result, ["top-only"]);
});

test("readWithFallback falls back when the all-frames read rejects", async () => {
    // A non-timeout failure of the all-frames read still yields the top frame
    // rather than failing the whole tab.
    const result = await readWithFallback(
        () => Promise.reject(new Error("frame blew up")),
        () => Promise.resolve(["top-after-error"]),
        50,
        200,
        "cap"
    );
    assert.deepEqual(result, ["top-after-error"]);
});

test("readWithFallback rejects with the cap message when the top frame also hangs", async () => {
    await assert.rejects(
        () => readWithFallback(() => never(), () => never(), 10, 20, "hard cap reached"),
        (err) => err.message === "hard cap reached"
    );
});

// ---------------------------------------------------------------------------
// captureAll

test("captureAll preserves input order even when items resolve out of order", async () => {
    const items = ["a", "b", "c"];
    // b resolves first, then c, then a; the result must still be a, b, c.
    const delays = { a: 30, b: 5, c: 15 };
    const results = await captureAll(items, (item) => after(delays[item], item.toUpperCase()));
    assert.deepEqual(results, ["A", "B", "C"]);
});

test("captureAll reports progress once per completion, ending at the total", async () => {
    const items = [1, 2, 3, 4];
    const seen = [];
    let lastTotal = null;
    await captureAll(
        items,
        (n) => after(n, n),
        (completed, total) => {
            seen.push(completed);
            lastTotal = total;
        }
    );
    assert.equal(seen.length, 4, "one progress call per item");
    assert.deepEqual(
        [...seen].sort((a, b) => a - b),
        [1, 2, 3, 4],
        "completed count climbs from 1 to N"
    );
    assert.equal(lastTotal, 4, "total is reported alongside completed");
});

test("captureAll works with no progress callback", async () => {
    const results = await captureAll([1, 2], (n) => Promise.resolve(n * 10));
    assert.deepEqual(results, [10, 20]);
});

test("captureAll returns an empty array for no items", async () => {
    const results = await captureAll([], () => Promise.resolve("x"));
    assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// failureNote

test("failureNote is empty when nothing failed", () => {
    assert.equal(failureNote(0, 0), "");
});

test("failureNote reports timeouts alone", () => {
    assert.equal(failureNote(1, 1), " 1 timed out.");
    assert.equal(failureNote(3, 3), " 3 timed out.");
});

test("failureNote reports non-timeout failures alone", () => {
    assert.equal(failureNote(2, 0), " 2 could not be read.");
});

test("failureNote reports a mix of timeouts and other failures", () => {
    assert.equal(failureNote(2, 1), " 1 timed out, 1 could not be read.");
});

// ---------------------------------------------------------------------------
// guardConcurrent

test("guardConcurrent ignores a second call while the first is in flight", async () => {
    // This is the download-stacking guard: a second export triggered before the
    // first finishes (a slow or blocked Save As dialog) must be dropped, so
    // duplicate downloads never queue.
    let runs = 0;
    const guarded = guardConcurrent(async () => {
        runs += 1;
        await after(20, "done");
        return "done";
    });

    const first = guarded();
    const second = guarded(); // fired while the first is still running
    const secondResult = await second;
    const firstResult = await first;

    assert.equal(runs, 1, "the task runs once, not twice");
    assert.equal(firstResult, "done");
    assert.equal(secondResult, undefined, "the ignored call resolves to undefined");
});

test("guardConcurrent allows a new call once the previous one settles", async () => {
    let runs = 0;
    const guarded = guardConcurrent(async () => {
        runs += 1;
        return after(5, runs);
    });

    await guarded();
    await guarded();

    assert.equal(runs, 2, "sequential calls each run");
});

test("guardConcurrent releases the lock when the task rejects", async () => {
    let runs = 0;
    const guarded = guardConcurrent(async () => {
        runs += 1;
        throw new Error("boom");
    });

    await assert.rejects(() => guarded(), /boom/);
    // The lock must be freed by the finally, so the next call still runs.
    await assert.rejects(() => guarded(), /boom/);
    assert.equal(runs, 2, "a rejecting task does not wedge the guard");
});

test("guardConcurrent forwards arguments and the return value", async () => {
    const guarded = guardConcurrent(async (a, b) => a + b);
    const result = await guarded(2, 3);
    assert.equal(result, 5);
});
