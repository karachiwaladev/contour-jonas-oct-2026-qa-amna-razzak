// Todo app backed by IndexedDB (client-side database). No server, no build step.
// Task shape: { id, title, done, createdAt, due: "YYYY-MM-DD" | null, tags: string[] }
const DB_NAME = "todo-app";
const STORE = "tasks";
const FILTER_KEY = "todo-app:filters";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Run one request inside a transaction and resolve with its result.
function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const api = (db) => ({
  all: () => run(db, "readonly", (s) => s.getAll()),
  add: (task) => run(db, "readwrite", (s) => s.add({ done: false, createdAt: Date.now(), ...task })),
  update: (task) => run(db, "readwrite", (s) => s.put(task)),
  remove: (id) => run(db, "readwrite", (s) => s.delete(id)),
});

// Tasks saved before due dates and tags existed have neither field.
const normalize = (t) => ({ ...t, due: t.due || null, tags: Array.isArray(t.tags) ? t.tags : [] });

const parseTags = (text) =>
  [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

const today = () => new Date().toISOString().slice(0, 10);

function formatDue(due) {
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Filters are remembered per browser; storage can be unavailable (private mode), so fall back quietly.
function loadFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
    return {
      status: ["all", "active", "done"].includes(saved.status) ? saved.status : "all",
      tags: new Set(Array.isArray(saved.tags) ? saved.tags : []),
    };
  } catch {
    return { status: "all", tags: new Set() };
  }
}

function saveFilter(filter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ status: filter.status, tags: [...filter.tags] }));
  } catch {}
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function main() {
  const tasks = api(await openDb());
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const form = document.getElementById("add-form");
  const titleInput = document.getElementById("new-task");
  const dueInput = document.getElementById("new-due");
  const tagsInput = document.getElementById("new-tags");
  const tagFilters = document.getElementById("tag-filters");
  const tagSep = document.getElementById("tag-sep");

  const filter = loadFilter();
  let editingId = null;

  const statusButtons = document.querySelectorAll("[data-status]");
  const syncStatusButtons = () =>
    statusButtons.forEach((b) => b.setAttribute("aria-pressed", b.dataset.status === filter.status));
  statusButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      filter.status = btn.dataset.status;
      saveFilter(filter);
      render();
    })
  );

  function renderTagFilters(allTags) {
    // Drop selected tags that no task uses any more, from the screen and from the saved filter.
    const stale = [...filter.tags].filter((tag) => !allTags.includes(tag));
    if (stale.length) {
      stale.forEach((tag) => filter.tags.delete(tag));
      saveFilter(filter);
    }
    tagFilters.replaceChildren();
    tagSep.hidden = !allTags.length;
    for (const tag of allTags) {
      const btn = el("button", { type: "button", className: "pill", textContent: `#${tag}` });
      btn.dataset.tag = tag;
      btn.setAttribute("aria-pressed", filter.tags.has(tag));
      btn.addEventListener("click", () => {
        filter.tags.has(tag) ? filter.tags.delete(tag) : filter.tags.add(tag);
        saveFilter(filter);
        render();
      });
      tagFilters.append(btn, " ");
    }
    if (filter.tags.size) {
      const clear = el("button", { type: "button", className: "link", id: "clear-tags", textContent: "Clear tags" });
      clear.addEventListener("click", () => {
        filter.tags.clear();
        saveFilter(filter);
        render();
      });
      tagFilters.append(clear);
    }
  }

  function renderEditRow(task) {
    const li = el("li", { className: "editing" });
    const titleField = el("input", { type: "text", name: "edit-title", value: task.title, required: true });
    titleField.setAttribute("aria-label", "Task title");
    const dueField = el("input", { type: "date", name: "edit-due", value: task.due || "" });
    dueField.setAttribute("aria-label", "Due date");
    const tagsField = el("input", { type: "text", name: "edit-tags", value: task.tags.join(", "), placeholder: "Tags, comma separated" });
    tagsField.setAttribute("aria-label", "Tags");

    const save = async () => {
      const title = titleField.value.trim();
      if (!title) return titleField.focus();
      editingId = null;
      await tasks.update({ ...task, title, due: dueField.value || null, tags: parseTags(tagsField.value) });
      render();
    };
    const cancel = () => {
      editingId = null;
      render();
    };

    const saveBtn = el("button", { type: "button", className: "save", textContent: "Save" });
    saveBtn.addEventListener("click", save);
    const cancelBtn = el("button", { type: "button", className: "link", textContent: "Cancel" });
    cancelBtn.addEventListener("click", cancel);

    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });

    li.append(
      el("div", { className: "edit-fields" }, titleField, el("div", { className: "row" }, dueField, tagsField)),
      el("div", { className: "actions" }, saveBtn, cancelBtn)
    );
    requestAnimationFrame(() => titleField.focus());
    return li;
  }

  function renderTask(task) {
    if (task.id === editingId) return renderEditRow(task);

    const li = el("li", { className: task.done ? "done" : "" });

    const box = el("input", { type: "checkbox", name: `done-${task.id}`, checked: task.done });
    box.setAttribute("aria-label", `Mark "${task.title}" done`);
    box.addEventListener("change", async () => {
      await tasks.update({ ...task, done: box.checked });
      render();
    });

    const body = el("div", { className: "body" }, el("div", { className: "title", textContent: task.title }));
    if (task.due || task.tags.length) {
      const meta = el("div", { className: "meta" });
      if (task.due) {
        const overdue = !task.done && task.due < today();
        meta.append(el("span", {
          className: "due" + (overdue ? " overdue" : ""),
          textContent: `Due ${formatDue(task.due)}${overdue ? " (overdue)" : ""}`,
        }));
      }
      for (const tag of task.tags) meta.append(el("span", { className: "tag", textContent: `#${tag}` }));
      body.append(meta);
    }

    const edit = el("button", { type: "button", className: "edit", textContent: "Edit" });
    edit.setAttribute("aria-label", `Edit "${task.title}"`);
    edit.addEventListener("click", () => {
      editingId = task.id;
      render();
    });

    const del = el("button", { type: "button", className: "delete", textContent: "Delete" });
    del.setAttribute("aria-label", `Delete "${task.title}"`);
    del.addEventListener("click", async () => {
      await tasks.remove(task.id);
      render();
    });

    li.append(box, body, el("div", { className: "actions" }, edit, del));
    return li;
  }

  async function render() {
    const items = (await tasks.all()).map(normalize);
    syncStatusButtons();
    renderTagFilters([...new Set(items.flatMap((t) => t.tags))].sort());

    const shown = items
      .filter((t) => filter.status === "all" || (filter.status === "done") === t.done)
      // Several selected tags: a task matches if it has any of them.
      .filter((t) => !filter.tags.size || t.tags.some((tag) => filter.tags.has(tag)))
      // Soonest due first; tasks without a due date keep their creation order at the end.
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.createdAt - b.createdAt);

    list.replaceChildren(...shown.map(renderTask));
    if (!shown.length) {
      list.innerHTML = `<li class="empty">${items.length ? "No tasks match these filters." : "No tasks yet. Add one above."}</li>`;
    }
    const open = items.filter((t) => !t.done).length;
    count.textContent = items.length ? `${open} of ${items.length} left · showing ${shown.length}` : "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    const task = { title, due: dueInput.value || null, tags: parseTags(tagsInput.value) };
    // Reset before the async save, so a quick second entry typed meanwhile isn't wiped.
    form.reset();
    titleInput.focus();
    await tasks.add(task);
    render();
  });

  render();
}

main().catch((err) => {
  document.getElementById("list").innerHTML = `<li class="empty">Could not open the database: ${err && err.message}</li>`;
});
