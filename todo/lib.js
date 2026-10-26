// Pure, DOM-free logic for the todo app: dates, repeat rules, tags and filtering.
// Loaded as a classic script in the browser (functions become globals used by app.js)
// and require()-d by the unit tests in Node (see module.exports at the bottom).

const validRepeat = (r) =>
  r && ["day", "week", "month"].includes(r.every) && Number.isInteger(r.interval) && r.interval >= 1 ? r : null;

// Tasks saved by earlier versions may lack due dates, tags or repeat rules.
const normalize = (t) => ({
  ...t,
  due: t.due || null,
  tags: Array.isArray(t.tags) ? t.tags : [],
  repeat: validRepeat(t.repeat),
});

const parseTags = (text) =>
  [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

// Dates are plain "YYYY-MM-DD" strings in local time (toISOString would shift them across the UTC boundary).
const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseISO = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const today = () => toISO(new Date());

function formatDue(due) {
  return parseISO(due).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// One step of a repeat rule. Monthly keeps the anchor day and uses the last day of shorter months
// (Jan 31 -> Feb 28/29 -> Mar 31), so the schedule doesn't drift.
function addStep(dateStr, repeat) {
  const d = parseISO(dateStr);
  if (repeat.every === "month") {
    const anchor = repeat.day || d.getDate();
    const target = new Date(d.getFullYear(), d.getMonth() + repeat.interval, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(anchor, lastDay));
    return toISO(target);
  }
  d.setDate(d.getDate() + (repeat.every === "week" ? 7 : 1) * repeat.interval);
  return toISO(d);
}

// Next due date after completing a task: one step on from its due date, skipping ahead past any
// dates already in the past so a late completion doesn't leave a backlog of overdue copies.
function nextDue(task, now = today()) {
  let next = addStep(task.due || now, task.repeat);
  while (next < now) next = addStep(next, task.repeat);
  return next;
}

function repeatLabel(r) {
  if (r.every === "day") return r.interval === 1 ? "Daily" : `Every ${r.interval} days`;
  if (r.every === "week") return r.interval === 1 ? "Weekly" : `Every ${r.interval} weeks`;
  return r.interval === 1 ? "Monthly" : `Every ${r.interval} months`;
}

// A recurring task needs a first due date (today if none was given); monthly rules remember its day.
function withRepeat(task, repeat, now = today()) {
  if (!repeat) return { ...task, repeat: null };
  const due = task.due || now;
  return { ...task, due, repeat: repeat.every === "month" ? { ...repeat, day: parseISO(due).getDate() } : repeat };
}

// Status + tag filtering (a task matches if it has any selected tag), sorted soonest due first;
// tasks without a due date keep their creation order at the end.
function applyFilter(items, filter) {
  return items
    .filter((t) => filter.status === "all" || (filter.status === "done") === t.done)
    .filter((t) => !filter.tags.size || t.tags.some((tag) => filter.tags.has(tag)))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.createdAt - b.createdAt);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    validRepeat, normalize, parseTags, toISO, parseISO, today, formatDue,
    addStep, nextDue, repeatLabel, withRepeat, applyFilter,
  };
}
