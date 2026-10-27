// Unit tests for the PreToolUse ticket gate and the circuit breaker. Offline: GitHub lookups are faked
// and the guard state lives in a temp folder. Run with: npm run test:unit
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.FACTORY_GUARD_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "guard-state-"));
const state = require("../.claude/hooks/guard-state.js");
const { decide } = require("../.claude/hooks/ticket-gate.js");

const reset = () => {
  fs.rmSync(process.env.FACTORY_GUARD_STATE, { recursive: true, force: true });
  fs.mkdirSync(process.env.FACTORY_GUARD_STATE, { recursive: true });
};
const screened = (n, verdict = "clean", at = new Date()) => state.writeScreen(n, { issue: n, verdict, screenedAt: at.toISOString() });

// Fake GitHub: issue 13 is quarantined, everything else isn't; PR 40 closes #13, PR 41 closes #12.
const deps = (over = {}) => ({
  circuit: state.circuit,
  screenStatus: (n) => state.screenStatus(n),
  readFile: (p) => ({ "pr-12.md": "Closes #12\n\nAdds priority.", "pr-13.md": "Closes #13" })[path.basename(p)] || "",
  issueLabels: (n) => (n === 13 ? ["quarantine"] : []),
  prClosingIssues: (n) => ({ 40: [13], 41: [12] })[n] || [],
  ...over,
});
const bash = (command, d = deps()) => decide({ tool_name: "Bash", tool_input: { command } }, d);

test("writes to an issue need a fresh, clean screening", () => {
  reset();
  assert.match(bash("gh issue comment 12 --body-file c.md").reason, /has not been screened/);
  screened(12);
  assert.equal(bash("gh issue comment 12 --body-file c.md"), null);
  assert.equal(bash('gh api -X POST "repos/o/r/issues/12/reactions" -f content=eyes --silent'), null);
  screened(12, "clean", new Date(Date.now() - 60 * 60000));
  assert.match(bash("gh issue close 12").reason, /older than/);
  screened(12, "untrusted");
  assert.match(bash("gh issue comment 12 -b hi").reason, /screened as untrusted/);
});

test("quarantined issues can't be touched, resolved, closed or merged, even if screened clean earlier", () => {
  reset();
  screened(13);
  for (const cmd of ["gh issue close 13 --reason completed", "gh issue comment 13 -b done", "gh api -X PATCH repos/o/r/issues/13 -f state=closed", "gh pr merge 40 --merge", "gh pr create --base main --head ticket-9-x --body-file pr-13.md"]) {
    const v = bash(cmd);
    assert.match(v.reason, /#13 is quarantined/, cmd);
    assert.equal(v.counts, true);
  }
  screened(12);
  assert.equal(bash("gh pr merge 41 --merge"), null);
  assert.equal(bash("gh pr create --base main --head ticket-6-priority --title T --body-file pr-12.md"), null);
});

test("fails closed when GitHub can't be checked", () => {
  reset();
  screened(12);
  const down = deps({ issueLabels: () => { throw new Error("network down"); }, prClosingIssues: () => { throw new Error("network down"); } });
  assert.match(bash("gh issue comment 12 -b x", down).reason, /failing closed/);
  assert.match(bash("gh pr merge 41", down).reason, /failing closed/);
});

test("only reviewers change the quarantine labels", () => {
  reset();
  screened(12);
  for (const cmd of ["gh issue edit 13 --remove-label quarantine", "gh issue edit 12 --add-label security-cleared", "gh api -X DELETE repos/o/r/issues/13/labels/quarantine", "gh label delete quarantine --yes"]) {
    assert.match(bash(cmd).reason, /only reviewers change|quarantined/, cmd);
  }
  assert.equal(bash("gh issue list --label quarantine"), null, "reading is fine");
  assert.equal(bash('node scripts/screen-ticket.js 12 --quarantine "blocked rm"'), null, "the screener may quarantine");
});

test("PRs from ticket branches must name the issue they close", () => {
  reset();
  assert.match(bash("gh pr create --base main --head ticket-6-priority --title T --body x").reason, /Closes #N/);
  assert.equal(bash("gh pr create --base main --head docs-tweak --title T --body x"), null);
});

test("token, secret, repo-setting and GraphQL-mutation commands are denied", () => {
  reset();
  for (const cmd of ["gh auth token", "gh auth status --show-token", "gh secret set X", "gh repo edit --visibility public", "gh repo delete o/r --yes", "gh api -X PUT repos/o/r/branches/main/protection --input p.json", "gh api -X PUT repos/o/r/collaborators/x", "gh api graphql -f query='mutation { addComment }'"]) {
    assert.equal(bash(cmd).counts, true, cmd);
  }
  for (const cmd of ["gh auth status", "gh issue view 12 --json title", "gh api repos/o/r/issues/12/comments", "gh api graphql -f query='query { viewer { login } }'", "gh pr checks 14 --watch"]) {
    assert.equal(bash(cmd), null, cmd);
  }
});

test("the guards themselves can't be edited by the agent", () => {
  reset();
  for (const p of ["D:\\repo\\.claude\\settings.json", "/repo/.claude/hooks/ticket-gate.js", ".claude/state/circuit-open.json", "scripts/ticket-guard/screen.js", "scripts/screen-ticket.js", ".github/workflows/ci.yml", ".claude/settings.local.json"]) {
    assert.ok(decide({ tool_name: "Edit", tool_input: { file_path: p } }, deps()), p);
    assert.ok(decide({ tool_name: "Write", tool_input: { file_path: p } }, deps()), p);
  }
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: "todo/app.js" } }, deps()), null);
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: ".claude/skills/factory-loop/SKILL.md" } }, deps()), null);
  for (const cmd of ["rm .claude/state/circuit-open.json", "echo {} > .claude/settings.json", "sed -i s/deny/allow/ .claude/settings.json", "git checkout main -- .claude/hooks/ticket-gate.js", "node -e \"require('fs').unlinkSync('.claude/state/circuit-open.json')\"", "Remove-Item .claude\\state\\circuit-open.json", "cp evil.js scripts/ticket-guard/screen.js"]) {
    assert.match(bash(cmd).reason, /protected guard file/, cmd);
  }
  for (const cmd of ["cat .claude/state/denials.jsonl", "git diff .claude/settings.json", "node --test tests/ticket-gate.test.js", "git add .claude/hooks/ticket-gate.js"]) {
    assert.equal(bash(cmd), null, cmd);
  }
});

test("stream redirects next to guard paths are not writes (the 2>&1 false positive that opened the circuit)", () => {
  reset();
  for (const cmd of [
    "test -f .claude/state/circuit-open.json 2>&1",
    'gh auth status 2>&1 | grep -E "Logged in"; test -f .claude/state/circuit-open.json && echo HALTED',
    "git add .claude/hooks/ticket-gate.js .claude/settings.json 2>&1 && git commit -q -F msg.txt",
    "cat .claude/state/denials.jsonl 2>&1 | tail -3",
  ]) {
    assert.equal(bash(cmd), null, cmd);
  }
  for (const cmd of ["echo x > .claude/state/circuit-open.json", "echo x >> .claude/settings.json"]) {
    assert.match(bash(cmd).reason, /protected guard file/, cmd);
  }
});

// Known gap: WRITE_VERB's (?<![0-9&]) lookbehind also skips numbered redirects to a file. Fixing it needs a
// human edit to ticket-gate.js (the agent can't touch guard files); suggested pattern: >{1,2}(?![>&]|\s*\/dev\/null)
test("numbered redirects into a guard file are writes", { todo: "needs a human fix in .claude/hooks/ticket-gate.js" }, () => {
  reset();
  for (const cmd of ["cat evil 1> .claude/hooks/ticket-gate.js", "echo {} 2> .claude/settings.json"]) {
    assert.match((bash(cmd) || {}).reason || "", /protected guard file/, cmd);
  }
});

test("circuit breaker: repeated security denials halt all GitHub writes and pushes", () => {
  reset();
  screened(12);
  assert.equal(state.recordDenial({ hook: "t", reason: "first", counts: true }).opened, false);
  assert.equal(state.recordDenial({ hook: "t", reason: "procedural", counts: false }).opened, false, "procedural denials don't count");
  assert.equal(state.recordDenial({ hook: "t", reason: "second", counts: true }).opened, true);
  assert.ok(state.circuit());
  assert.match(bash("gh issue comment 12 -b x").reason, /circuit breaker is open/);
  assert.match(bash("git push -u origin ticket-6-priority").reason, /circuit breaker is open/);
  assert.equal(bash("git status"), null, "local, read-only work still runs");
  assert.equal(bash("gh issue view 12"), null);
});

test("old denials outside the window don't trip the breaker", () => {
  reset();
  const twoHoursAgo = Date.now() - 120 * 60000;
  state.recordDenial({ hook: "t", reason: "old", counts: true }, twoHoursAgo);
  assert.equal(state.recordDenial({ hook: "t", reason: "new", counts: true }).opened, false);
});
