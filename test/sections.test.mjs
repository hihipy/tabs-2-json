import test from "node:test";
import assert from "node:assert/strict";
import {
    buildTabSections,
    TAB_GROUP_ID_NONE,
    normalizeSelectionScope,
    DEFAULT_SETTINGS
} from "../src/lib/extract.js";

const tab = (id, windowId, groupId, extra = {}) => ({
    id, windowId, groupId, title: "Tab " + id, url: "https://e.com/" + id, ...extra
});

test("current window sorts first and is labelled by relation", () => {
    const out = buildTabSections(
        [tab(1, 20, -1), tab(2, 10, -1)],
        [],
        10
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].windowId, 10);
    assert.equal(out[0].label, "This window");
    assert.equal(out[0].isCurrent, true);
    assert.equal(out[1].label, "Window 2");
});

test("groups nest inside their window at the position of the first member", () => {
    const out = buildTabSections(
        [tab(1, 10, -1), tab(2, 10, 5), tab(3, 10, 5), tab(4, 10, -1)],
        [{ id: 5, title: "Research", color: "pink", windowId: 10 }],
        10
    );
    const items = out[0].items;
    assert.deepEqual(items.map((i) => i.kind), ["tab", "group", "tab"]);
    assert.equal(items[1].title, "Research");
    assert.equal(items[1].color, "pink");
    assert.deepEqual(items[1].tabs.map((t) => t.id), [2, 3]);
});

test("an untitled group is named by its color", () => {
    const out = buildTabSections([tab(1, 10, 7)], [{ id: 7, color: "cyan" }], 10);
    assert.equal(out[0].items[0].title, "Cyan group");
});

test("a group with no metadata falls back to grey", () => {
    const out = buildTabSections([tab(1, 10, 9)], [], 10);
    assert.equal(out[0].items[0].color, "grey");
    assert.equal(out[0].items[0].title, "Grey group");
});

test("the same group id in two windows stays in its own window", () => {
    const out = buildTabSections(
        [tab(1, 10, 3), tab(2, 20, 3)],
        [{ id: 3, title: "G", color: "blue" }],
        10
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].items[0].tabs.length, 1);
    assert.equal(out[1].items[0].tabs.length, 1);
});

test("tab order within a window is preserved", () => {
    const out = buildTabSections([tab(3, 10, -1), tab(1, 10, -1), tab(2, 10, -1)], [], 10);
    assert.deepEqual(out[0].items.map((i) => i.tab.id), [3, 1, 2]);
});

test("the active tab title is carried for identification", () => {
    const out = buildTabSections(
        [tab(1, 10, -1), tab(2, 20, -1, { active: true, title: "Gmail" })],
        [],
        10
    );
    assert.equal(out[1].activeTitle, "Gmail");
    assert.equal(out[0].activeTitle, "");
});

test("no current window still labels every section", () => {
    const out = buildTabSections([tab(1, 10, -1), tab(2, 20, -1)], [], 999);
    assert.deepEqual(out.map((s) => s.label), ["Window 1", "Window 2"]);
    assert.equal(out.some((s) => s.isCurrent), false);
});

test("missing groupId is treated as ungrouped", () => {
    const out = buildTabSections([{ id: 1, windowId: 10, title: "t", url: "u" }], [], 10);
    assert.equal(out[0].items[0].kind, "tab");
});

test("empty and malformed input does not throw", () => {
    assert.deepEqual(buildTabSections([], [], 1), []);
    assert.deepEqual(buildTabSections(null, null, null), []);
    assert.deepEqual(buildTabSections([null, tab(1, 10, -1)], [null], 10).length, 1);
});

test("TAB_GROUP_ID_NONE matches the browser constant", () => {
    assert.equal(TAB_GROUP_ID_NONE, -1);
});

test("normalizeSelectionScope accepts the three real scopes", () => {
    assert.equal(normalizeSelectionScope("window"), "window");
    assert.equal(normalizeSelectionScope("all"), "all");
    assert.equal(normalizeSelectionScope("none"), "none");
});

test("normalizeSelectionScope falls back for anything else", () => {
    ["", "All", "everything", null, undefined, 0, {}, []].forEach((value) => {
        assert.equal(normalizeSelectionScope(value), "window");
    });
});

test("the new settings ship with the previous behaviour as their default", () => {
    assert.equal(DEFAULT_SETTINGS.defaultSelection, "window");
    assert.equal(DEFAULT_SETTINGS.hideUnreadable, false);
});
