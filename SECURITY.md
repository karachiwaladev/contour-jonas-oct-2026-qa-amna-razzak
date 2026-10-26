# Security

This is a training repo: no real keys, no Jonas or Contour code.

## Guardrails
- **`main` is protected.** Changes land only through a pull request that passes CI (`test`). Force-pushes and branch deletion are blocked.
- **CI runs `npm run security` on every PR.** It fails on secret-looking files or tokens, on unsafe DOM sinks in app code (`innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`), and on pages without a strict Content-Security-Policy.
- **The todo app** renders user text with `textContent` only and ships a CSP of `default-src 'self'`, with no inline script or style.
- **The factory loop** only acts on issues and approvals from repo collaborators, never merges its own PR without a person's approval, and never takes destructive actions. See `.claude/skills/factory-loop/SKILL.md`.
- **The session prompt log** (`.claude/logs/`) stays on your machine and is git-ignored. Earlier versions were committed, so they remain in git history.

## Reporting
Found a problem? Open an issue without the sensitive details and mention @Amna-razzak, or contact the workshop team directly.
