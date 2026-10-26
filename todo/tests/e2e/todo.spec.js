// End-to-end tests for the todo app (tickets #3, #4 and #5). Run with: npm run test:e2e
const { test, expect } = require("@playwright/test");

// Freeze "today" so due-date and recurrence assertions are deterministic.
const TODAY = new Date("2026-10-26T10:00:00");

const titles = (page) => page.locator("#list li:not(.empty) .title");
const row = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: new RegExp(`^${title}$`) }) });

async function addTask(page, title, { due = "", tags = "", repeat = "", every } = {}) {
  await page.fill("#new-task", title);
  await page.fill("#new-due", due);
  await page.fill("#new-tags", tags);
  await page.selectOption("select[name=new-repeat]", repeat);
  if (every) await page.fill("input[name=new-interval]", String(every));
  await page.press("#new-task", "Enter");
  await expect(titles(page).filter({ hasText: new RegExp(`^${title}$`) }).first()).toBeVisible();
}

let consoleErrors;
test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  await page.clock.setFixedTime(TODAY);
  await page.goto("/");
  await expect(page.locator("#list li")).toHaveCount(1); // the empty-state row
});

test.afterEach(() => {
  expect(consoleErrors, "no console errors or CSP violations").toEqual([]);
});

test.describe("Ticket #3: basic todo", () => {
  test("create, complete, delete and persist", async ({ page }) => {
    await expect(page.locator("#list .empty")).toHaveText("No tasks yet. Add one above.");
    await addTask(page, "Buy milk");
    await expect(page.locator("#count")).toHaveText("1 of 1 left · showing 1");

    await row(page, "Buy milk").locator("input[type=checkbox]").check();
    await expect(row(page, "Buy milk")).toHaveClass(/done/);

    await page.reload();
    await expect(row(page, "Buy milk")).toHaveClass(/done/);

    await row(page, "Buy milk").getByRole("button", { name: /Delete/ }).click();
    await expect(page.locator("#list .empty")).toHaveText("No tasks yet. Add one above.");
  });

  test("blank titles are ignored", async ({ page }) => {
    await page.fill("#new-task", "   ");
    await page.press("#new-task", "Enter");
    await expect(titles(page)).toHaveCount(0);
  });
});

test.describe("Ticket #4: filters, due dates and tags", () => {
  test.beforeEach(async ({ page }) => {
    await addTask(page, "Pay rent", { due: "2099-01-15", tags: "Home, money, home" });
    await addTask(page, "Old bill", { due: "2026-10-01", tags: "money" });
    await addTask(page, "Buy milk");
    await row(page, "Buy milk").locator("input[type=checkbox]").check();
    await expect(row(page, "Buy milk")).toHaveClass(/done/);
  });

  test("due dates sort soonest first and overdue is flagged", async ({ page }) => {
    await expect(titles(page)).toHaveText(["Old bill", "Pay rent", "Buy milk"]);
    await expect(row(page, "Old bill").locator(".due")).toHaveText("Due Oct 1, 2026 (overdue)");
    await expect(row(page, "Pay rent").locator(".tag")).toHaveText(["#home", "#money"]);
  });

  test("status and multi-tag filters combine and persist", async ({ page }) => {
    await page.click("[data-status=active]");
    await expect(titles(page)).toHaveText(["Old bill", "Pay rent"]);
    await page.click("[data-status=done]");
    await expect(titles(page)).toHaveText(["Buy milk"]);
    await page.click("[data-status=all]");

    await page.click("[data-tag=home]");
    await expect(titles(page)).toHaveText(["Pay rent"]);
    await page.click("[data-tag=money]");
    await expect(titles(page)).toHaveText(["Old bill", "Pay rent"]);
    await page.click("[data-status=active]");

    await page.reload();
    await expect(page.locator("[data-status=active]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-tag][aria-pressed=true]")).toHaveText(["#home", "#money"]);
    await page.click("#clear-tags");
    await expect(page.locator("#clear-tags")).toHaveCount(0);
  });

  test("inline edit saves with Enter, cancels with Esc, refuses blank titles", async ({ page }) => {
    await row(page, "Pay rent").getByRole("button", { name: /Edit/ }).click();
    const editor = page.locator("#list li.editing");
    await editor.locator("input[name=edit-title]").fill("Pay rent (Nov)");
    await editor.locator("input[name=edit-tags]").fill("home, bills");
    await editor.locator("input[name=edit-title]").press("Enter");
    await expect(row(page, "Pay rent \\(Nov\\)").locator(".tag")).toHaveText(["#home", "#bills"]);

    await row(page, "Old bill").getByRole("button", { name: /Edit/ }).click();
    await page.locator("#list li.editing input[name=edit-title]").fill("SHOULD NOT SAVE");
    await page.locator("#list li.editing input[name=edit-title]").press("Escape");
    await expect(titles(page).filter({ hasText: "SHOULD NOT SAVE" })).toHaveCount(0);

    await row(page, "Old bill").getByRole("button", { name: /Edit/ }).click();
    await page.locator("#list li.editing input[name=edit-title]").fill("  ");
    await page.locator("#list li.editing button.save").click();
    await expect(page.locator("#list li.editing")).toHaveCount(1);
  });
});

test.describe("Ticket #5: recurring tasks", () => {
  test("completing creates the next occurrence once", async ({ page }) => {
    await addTask(page, "Water plants", { due: "2026-10-26", tags: "home", repeat: "days", every: 3 });
    await expect(row(page, "Water plants").locator(".repeat")).toHaveText("↻ Every 3 days");

    await row(page, "Water plants").locator("input[type=checkbox]").check();
    const upcoming = page.locator("#list li:not(.done)", { hasText: "Water plants" });
    await expect(upcoming.locator(".due")).toHaveText("Due Oct 29, 2026");
    await expect(upcoming.locator(".tag")).toHaveText(["#home"]);

    const done = page.locator("#list li.done", { hasText: "Water plants" });
    await done.locator("input[type=checkbox]").uncheck();
    await page.locator("#list li:not(.done)", { hasText: "Oct 26" }).locator("input[type=checkbox]").check();
    await expect(titles(page).filter({ hasText: "Water plants" })).toHaveCount(2);
  });

  test("late completion skips ahead; monthly clamps to month end", async ({ page }) => {
    await addTask(page, "Weekly report", { due: "2026-10-06", repeat: "week" });
    await addTask(page, "Pay rent", { due: "2027-01-31", repeat: "month" });
    await row(page, "Weekly report").locator("input[type=checkbox]").check();
    await row(page, "Pay rent").locator("input[type=checkbox]").check();
    await expect(page.locator("#list li:not(.done)", { hasText: "Weekly report" }).locator(".due")).toHaveText("Due Oct 27, 2026");
    await expect(page.locator("#list li:not(.done)", { hasText: "Pay rent" }).locator(".due")).toHaveText("Due Feb 28, 2027");
  });

  test("Doesn't repeat stops the series", async ({ page }) => {
    await addTask(page, "Standup", { due: "2026-10-27", repeat: "week" });
    await row(page, "Standup").getByRole("button", { name: /Edit/ }).click();
    await page.locator("#list li.editing select[name=edit-repeat]").selectOption("");
    await page.locator("#list li.editing button.save").click();
    await expect(row(page, "Standup").locator(".repeat")).toHaveCount(0);
    await row(page, "Standup").locator("input[type=checkbox]").check();
    await expect(titles(page).filter({ hasText: "Standup" })).toHaveCount(1);
  });
});

test.describe("Security", () => {
  test("markup in a title is shown as text, never executed", async ({ page }) => {
    const payload = `<img src=x onerror="window.__xss=1">`;
    await addTask(page, payload, { tags: "<b>tag</b>" });
    await expect(titles(page).first()).toHaveText(payload);
    await expect(page.locator("#list img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test("page ships a strict Content-Security-Policy", async ({ page }) => {
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("object-src 'none'");
  });
});
