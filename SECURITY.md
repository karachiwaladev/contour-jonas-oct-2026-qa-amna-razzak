# Security

This is a training repo: no real keys, no Jonas or Contour code.

## Guardrails
- **`main` should be protected** (PR + passing `test` check, no force-push or deletion). This needs a repo admin and **is not applied yet**. Until it is, the rules below are the protection.
- **CI runs `npm run security` on every PR.** It fails on:
  - secret-looking files or tokens
  - unsafe DOM sinks in app code (`innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`)
  - pages without a strict Content-Security-Policy
- **The todo app** renders user text with `textContent` only and ships a CSP of `default-src 'self'`, with no inline script or style.
- **The factory loop** never merges its own PR without a person's approval and never takes destructive actions. See `.claude/skills/factory-loop/SKILL.md`.

## Malicious tickets: screening and quarantine
Security decisions are enforced by code and tool permissions, not only by the agent's instructions.

1. **Screening.** `scripts/screen-ticket.js` screens every ticket before the loop touches it, and again on every tick. Rules: `scripts/ticket-guard/`, config: `config.json`. It looks for:
   - prompt injection
   - hidden content (HTML comments, invisible or bidi characters, CSS-hidden text, encoded blobs)
   - suspicious links (shorteners, raw IPs, paste or webhook hosts, scripts, hosts not on the allowlist)
   - requests for secrets, and exposed secrets
   - unauthorized actions

   **Any finding quarantines the ticket**: it gets the `quarantine` label, the reviewer (`reviewers` in the config) is @mentioned and assigned, and the reasons are posted (defanged) and logged in `.claude/logs/quarantine.jsonl`.
2. **Server-side backstop.** `.github/workflows/ticket-screen.yml` runs the same screening on GitHub for every new or edited issue and comment. CI's quarantine gate fails any PR that would close a quarantined ticket.
3. **Gate.** `.claude/hooks/ticket-gate.js` (PreToolUse) blocks:
   - writes to issues that weren't screened clean in the last 30 minutes
   - any write to a quarantined issue (live label check; it fails closed if GitHub can't be reached)
   - merging a PR that closes a quarantined issue
   - changing the quarantine labels
   - token, secret, repo-setting and GraphQL-mutation commands
4. **Dangerous commands.** `permissions.deny` and `.claude/hooks/block-dangerous.js` block `rm -rf`, `git push --force`, `curl … | sh` and reading `.env` files.
5. **No automatic retries.** Every block is logged in `.claude/state/denials.jsonl`. Two security blocks within an hour open a **circuit breaker** (`.claude/state/circuit-open.json`), which halts all GitHub writes and pushes until a human reviews the log and deletes the file.
6. **The guards protect themselves.** The agent can't edit `.claude/settings*.json`, `.claude/hooks/`, `.claude/state/`, the screening code or `.github/workflows/`, through permission rules and the gate. A person makes those changes.

**Releasing a quarantined ticket** (reviewers only, in the GitHub UI): check it, remove `quarantine` and add `security-cleared`. Anything edited or commented after that is screened again. The loop never resolves or closes a quarantined ticket.

**Limits:**
- The hooks are a strong guard rail, not a sandbox. An agent that writes and runs a brand-new script could in theory get past the shell checks.
- The agent and a human share the same GitHub account, so GitHub itself can't tell them apart.

For a hard boundary, run the loop in a sandbox (Claude Code sandbox mode or a container) with a fine-grained token limited to this repo, and apply branch protection plus `CODEOWNERS`.

## Other notes
- **The session prompt log** (`.claude/logs/`) stays on your machine and is git-ignored. Earlier versions were committed, so they remain in git history.

## Reporting
Found a problem? Open an issue without the sensitive details and mention @Amna-razzak, or contact the workshop team directly.
