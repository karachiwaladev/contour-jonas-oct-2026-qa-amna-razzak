// Todo app backed by IndexedDB (client-side database). No server, no build step.
// Task shape: { id, title, done, createdAt, due: "YYYY-MM-DD" | null, tags: string[] }
const DB_NAME = "todo-app";
const STORE = "tasks";

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

  const filter = { status: "all", tag: null };

  document.querySelectorAll("[data-status]").forEach((btn) =>
    btn.addEventListener("click", () => {
      filter.status = btn.dataset.status;
      document.querySelectorAll("[data-status]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      render();
    })
  );

  function renderTagFilters(allTags) {
    if (filter.tag && !allTags.includes(filter.tag)) filter.tag = null;
    tagFilters.replaceChildren();
    tagSep.hidden = !allTags.length;
    for (const tag of allTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill";
      btn.dataset.tag = tag;
      btn.textContent = `#${tag}`;
      btn.setAttribute("aria-pressed", filter.tag === tag);
      btn.addEventListener("click", () => {
        filter.tag = filter.tag === tag ? null : tag;
        render();
      });
      tagFilters.append(btn, " ");
    }
  }

  function renderTask(task) {
    const li = document.createElement("li");
    li.className = task.done ? "done" : "";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = task.done;
    box.setAttribute("aria-label", `Mark "${task.title}" done`);
    box.addEventListener("change", async () => {
      await tasks.update({ ...task, done: box.checked });
      render();
    });

    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = task.title;
    body.append(title);

    if (task.due || task.tags.length) {
      const meta = document.createElement("div");
      meta.className = "meta";
      if (task.due) {
        const due = document.createElement("span");
        const overdue = !task.done && task.due < today();
        due.className = "due" + (overdue ? " overdue" : "");
        due.textContent = `Due ${formatDue(task.due)}${overdue ? " (overdue)" : ""}`;
        meta.append(due);
      }
      for (const tag of task.tags) {
        const chip = document.createElement("span");
        chip.className = "tag";
        chip.textContent = `#${tag}`;
        meta.append(chip);
      }
      body.append(meta);
    }

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete "${task.title}"`);
    del.addEventListener("click", async () => {
      await tasks.remove(task.id);
      render();
    });

    li.append(box, body, del);
    return li;
  }

  async function render() {
    const items = (await tasks.all()).map(normalize);
    renderTagFilters([...new Set(items.flatMap((t) => t.tags))].sort());

    const shown = items
      .filter((t) => filter.status === "all" || (filter.status === "done") === t.done)
      .filter((t) => !filter.tag || t.tags.includes(filter.tag))
      // Soonest due first; tasks without a due date keep their creation order at the end.
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.createdAt - b.createdAt);

    list.replaceChildren(...shown.map(renderTask));
    if (!shown.length) {
      list.innerHTML = `<li class="empty">${items.length ? "No tasks match this filter." : "No tasks yet. Add one above."}</li>`;
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
