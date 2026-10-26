// Unit tests for todo/lib.js. Run with: npm run test:unit
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../../lib.js");

const R = (every, interval = 1, day) => ({ every, interval, ...(day ? { day } : {}) });

test("parseTags trims, lowercases and de-duplicates", () => {
  assert.deepEqual(lib.parseTags(" Home, money , home,,  "), ["home", "money"]);
  assert.deepEqual(lib.parseTags(""), []);
});

test("toISO / parseISO round-trip in local time", () => {
  assert.equal(lib.toISO(lib.parseISO("2026-03-09")), "2026-03-09");
  assert.equal(lib.toISO(new Date(2026, 0, 5)), "2026-01-05");
});

test("validRepeat accepts good rules and rejects bad ones", () => {
  assert.deepEqual(lib.validRepeat(R("week")), R("week"));
  assert.equal(lib.validRepeat(null), null);
  assert.equal(lib.validRepeat({ every: "year", interval: 1 }), null);
  assert.equal(lib.validRepeat({ every: "day", interval: 0 }), null);
  assert.equal(lib.validRepeat({ every: "day", interval: 1.5 }), null);
});

test("normalize fills in fields missing from older tasks", () => {
  const t = lib.normalize({ id: 1, title: "Old", done: false, createdAt: 1 });
  assert.equal(t.due, null);
  assert.deepEqual(t.tags, []);
  assert.equal(t.repeat, null);
});

test("addStep: daily, every N days, weekly, year rollover", () => {
  assert.equal(lib.addStep("2026-10-26", R("day")), "2026-10-27");
  assert.equal(lib.addStep("2026-10-26", R("day", 3)), "2026-10-29");
  assert.equal(lib.addStep("2026-10-27", R("week")), "2026-11-03");
  assert.equal(lib.addStep("2026-12-31", R("day")), "2027-01-01");
});

test("addStep: monthly keeps the anchor day and clamps to month end", () => {
  assert.equal(lib.addStep("2027-01-31", R("month", 1, 31)), "2027-02-28");
  assert.equal(lib.addStep("2027-02-28", R("month", 1, 31)), "2027-03-31");
  assert.equal(lib.addStep("2028-01-31", R("month", 1, 31)), "2028-02-29"); // leap year
  assert.equal(lib.addStep("2026-10-15", R("month", 1)), "2026-11-15");
});

test("nextDue skips past dates so late completions leave no backlog", () => {
  const now = "2026-10-26";
  assert.equal(lib.nextDue({ due: "2026-10-06", repeat: R("week") }, now), "2026-10-27");
  assert.equal(lib.nextDue({ due: "2026-10-01", repeat: R("day") }, now), "2026-10-26");
  assert.equal(lib.nextDue({ due: "2026-10-30", repeat: R("day") }, now), "2026-10-31");
  assert.equal(lib.nextDue({ due: null, repeat: R("day") }, now), "2026-10-27");
});

test("withRepeat starts undated recurring tasks today and anchors monthly rules", () => {
  const now = "2026-10-26";
  assert.deepEqual(lib.withRepeat({ title: "x", due: null }, null, now), { title: "x", due: null, repeat: null });
  assert.equal(lib.withRepeat({ title: "x", due: null }, R("day"), now).due, now);
  assert.equal(lib.withRepeat({ title: "x", due: "2027-01-31" }, R("month"), now).repeat.day, 31);
});

test("repeatLabel", () => {
  assert.deepEqual(
    [R("day"), R("day", 3), R("week"), R("week", 2), R("month")].map(lib.repeatLabel),
    ["Daily", "Every 3 days", "Weekly", "Every 2 weeks", "Monthly"]
  );
});

test("applyFilter: status, any-of tags, and due-date ordering", () => {
  const items = [
    { title: "a", done: false, due: null, tags: ["home"], createdAt: 1 },
    { title: "b", done: true, due: "2026-11-01", tags: ["money"], createdAt: 2 },
    { title: "c", done: false, due: "2026-10-27", tags: ["work", "money"], createdAt: 3 },
  ];
  const titles = (f) => lib.applyFilter(items, f).map((t) => t.title);
  assert.deepEqual(titles({ status: "all", tags: new Set() }), ["c", "b", "a"]);
  assert.deepEqual(titles({ status: "active", tags: new Set() }), ["c", "a"]);
  assert.deepEqual(titles({ status: "done", tags: new Set() }), ["b"]);
  assert.deepEqual(titles({ status: "all", tags: new Set(["money"]) }), ["c", "b"]);
  assert.deepEqual(titles({ status: "all", tags: new Set(["home", "work"]) }), ["c", "a"]);
  assert.deepEqual(titles({ status: "active", tags: new Set(["money"]) }), ["c"]);
});
