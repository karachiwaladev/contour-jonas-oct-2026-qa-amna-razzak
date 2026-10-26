// Todo app backed by IndexedDB (client-side database). No server, no build step.
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
  add: (title) => run(db, "readwrite", (s) => s.add({ title, done: false, createdAt: Date.now() })),
  update: (task) => run(db, "readwrite", (s) => s.put(task)),
  remove: (id) => run(db, "readwrite", (s) => s.delete(id)),
});

async function main() {
  const tasks = api(await openDb());
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const form = document.getElementById("add-form");
  const input = document.getElementById("new-task");

  async function render() {
    const items = await tasks.all();
    list.replaceChildren();
    if (!items.length) {
      list.innerHTML = '<li class="empty">No tasks yet. Add one above.</li>';
    }
    for (const task of items) {
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

      const label = document.createElement("span");
      label.textContent = task.title;

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.setAttribute("aria-label", `Delete "${task.title}"`);
      del.addEventListener("click", async () => {
        await tasks.remove(task.id);
        render();
      });

      li.append(box, label, del);
      list.append(li);
    }
    const open = items.filter((t) => !t.done).length;
    count.textContent = items.length ? `${open} of ${items.length} left` : "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    await tasks.add(title);
    input.value = "";
    render();
  });

  render();
}

main().catch((err) => {
  document.getElementById("list").innerHTML = `<li class="empty">Could not open the database: ${err && err.message}</li>`;
});
