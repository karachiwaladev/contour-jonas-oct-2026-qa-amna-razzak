# Todo app

A small todo app with a simple interface. Tasks are stored in the browser with **IndexedDB**, a client-side database, so there is no server or build step.

## Features
- Create a task
- Mark a task done (or undo it)
- Delete a task
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
| `app.js` | IndexedDB access (`todo-app` database, `tasks` store) and UI rendering |

## Manual test checklist
1. Add "Buy milk". It appears in the list and the counter shows `1 of 1 left`.
2. Tick its checkbox. It is crossed out and the counter shows `0 of 1 left`.
3. Reload the page. The task is still there and still done.
4. Click **Delete**. The list shows "No tasks yet".
5. Submitting an empty or blank task does nothing.
