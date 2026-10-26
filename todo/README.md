# Todo app

A small todo app with a simple interface. Tasks are stored in the browser with **IndexedDB**, a client-side database, so there is no server or build step.

## Features
- Create a task, with an optional **due date** and optional **tags** (comma separated)
- **Edit** a task's title, due date and tags inline (Enter saves, Esc cancels)
- Mark a task done (or undo it), and delete it
- **Filter by status:** All, Incomplete or Completed
- **Filter by tags:** select one or more tags; a task shows if it has *any* of them. **Clear tags** resets.
- Status and tag filters combine, and are **remembered** across reloads (`localStorage`)
- Tasks are sorted by due date (soonest first); overdue incomplete tasks are shown in red
- Tasks persist across page reloads, per browser (IndexedDB)

## Run it
Open `todo/index.html` in a browser. Or serve the folder:

```bash
npx serve todo      # or: python -m http.server -d todo
```

## Files
| File | Purpose |
|---|---|
| `index.html` | Page markup and styles (light and dark) |
| `app.js` | IndexedDB access (`todo-app` database, `tasks` store), filtering and rendering |

Task records: `{ id, title, done, createdAt, due: "YYYY-MM-DD" | null, tags: string[] }`.
Tasks saved before due dates and tags existed still load; they simply have neither.

## Manual test checklist
1. Add "Buy milk". It appears and the counter shows `1 of 1 left`.
2. Add "Pay rent" with a due date and the tags `home, money`. Its due date and `#home` `#money` chips show, and tag filter buttons appear.
3. Tick "Buy milk". It is crossed out.
4. Click **Incomplete**: only "Pay rent" shows. Click **Completed**: only "Buy milk" shows. Click **All**: both show.
5. Click `#money`: only "Pay rent" shows. Also click `#home`: tasks with either tag show. **Clear tags** resets.
6. Click **Edit** on "Buy milk", set a due date and the tag `shop`, press Enter. The changes show; reload and they're kept.
7. Click **Edit**, change the title, press Esc: nothing changes.
8. Choose **Incomplete** and `#money`, then reload: both filters are still selected.
9. Add a task with a past due date: it shows "(overdue)" in red.
10. Delete a task. Tags no longer used by any task disappear from the filters (and from the saved filter).
11. Submitting an empty or blank task does nothing.
