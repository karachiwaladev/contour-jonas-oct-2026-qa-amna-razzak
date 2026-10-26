# Todo app

A small todo app with a simple interface. Tasks are stored in the browser with **IndexedDB**, a client-side database, so there is no server or build step.

## Features
- Create a task, with an optional **due date** and optional **tags** (comma separated)
- Mark a task done (or undo it), and delete it
- **Filter by status:** All, Incomplete or Completed
- **Filter by tag:** one button per tag in use; click again to clear
- Tasks are sorted by due date (soonest first); overdue incomplete tasks are shown in red
- Tasks persist across page reloads, per browser

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
5. Click `#money`: only "Pay rent" shows. Click it again: the tag filter clears.
6. Add a task with a past due date: it shows "(overdue)" in red.
7. Reload the page. Tasks, due dates, tags and done state are all kept.
8. Delete a task. Tags no longer used by any task disappear from the filters.
9. Submitting an empty or blank task does nothing.
