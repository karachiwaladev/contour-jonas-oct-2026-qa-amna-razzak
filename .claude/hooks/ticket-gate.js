#!/usr/bin/env node
// PreToolUse gate that enforces the factory's security decisions in code, whatever the model was told:
//   1. While the circuit breaker is open (repeated blocked actions), no GitHub writes and no pushes.
//   2. No write to an issue unless scripts/screen-ticket.js screened it clean in the last few minutes.
//   3. No write to a quarantined issue (live label check on GitHub; fails closed if it can't check),
//      and no merging a PR that closes one.
//   4. Only reviewers change the quarantine labels, in the GitHub UI: the agent can't add/remove them.
//   5. The guards themselves (settings, hooks, state, screening code, workflows) can't be edited by the agent.
//   6. No token/secret commands, repo settings, secrets, rulesets or GraphQL mutations.
// Every security denial is recorded; repeated ones open the circuit, so blocked actions aren't retried.
const { execFileSync } = require("child_process");
const fs = require("fs");
const config = require("../../scripts/ticket-guard/config.json");
const state = require("./guard-state.js");

const PROTECTED = /(?:^|[\s"'`=\/\\(])(\.claude[\/\\](?:settings(?:\.local)?\.json|hooks|state)|scripts[\/\\](?:screen-ticket\.js|ticket-guard)|\.github[\/\\]workflows)/;
const PROTECTED_PATH = /[\/\\]?(\.claude[\/\\](settings(\.local)?\.json|hooks[\/\\]|state[\/\\])|scripts[\/\\](screen-ticket\.js|ticket-guard[\/\\])|\.github[\/\\]workflows[\/\\])/;
const WRITE_VERB =
  /(?:^|[\s;&|(])(?:rm|rmdir|mv|cp|del|erase|move|copy|ren|tee|truncate|touch|chmod|unlink|ln|install|dd|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Set-Content|Add-Content|Out-File|Clear-Content)\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|(?<![0-9&])>{1,2}(?!&)|\bgit\s+(checkout|restore|rm|mv|stash|reset|clean|apply|am)\b|\b(node|python3?|perl|ruby|deno|bun)\s+(-e|-c|--eval|-p)\b|\b(pwsh|powershell)\b[^|]*\s-(c|command)\b|\bbash\s+-c\b|\bsh\s+-c\b/i;
const QUARANTINE_LABELS = new RegExp(`\\b(${config.quarantineLabel}|${config.clearedLabel})\\b`, "i");
const SCREEN_CMD = /^\s*node\s+["']?(?:\.\/)?scripts[\/\\]screen-ticket\.js\b/;

const ISSUE_WRITE = /^(comment|close|reopen|edit|lock|unlock|delete|transfer|pin|unpin|develop)$/;
const PR_WRITE = /^(merge|create|comment|edit|close|reopen|ready|review)$/;

// Split a shell line into simple commands (good enough for gate decisions; quotes keep their content).
function segments(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
    .map((s) => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ""))
    .filter(Boolean);
}

function words(seg) {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ""));
}

const optionValue = (w, ...names) => {
  for (const n of names) {
    const i = w.indexOf(n);
    if (i >= 0 && w[i + 1]) return w[i + 1];
    const eq = w.find((x) => x.startsWith(`${n}=`));
    if (eq) return eq.slice(n.length + 1);
  }
  return null;
};

const firstNumber = (w) => {
  const n = w.find((x) => /^#?\d+$/.test(x));
  return n ? Number(n.replace("#", "")) : null;
};

const closesIn = (text) => [...String(text || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1]));

// Classify one gh command: { write, issues: [n], pr, kind, deny?: reason }
function classifyGh(w, readFile) {
  const [, group, sub] = w;
  if (group === "auth" && (sub === "token" || w.includes("--show-token"))) return { deny: "printing the GitHub token" };
  if (["secret", "variable", "ruleset"].includes(group) && sub && !["list", "view"].includes(sub)) return { deny: `changing repository ${group}s` };
  if (group === "repo" && /^(edit|delete|rename|archive|unarchive|transfer|deploy-key)$/.test(sub || "")) return { deny: `gh repo ${sub} (repository settings)` };
  if (group === "issue" && ISSUE_WRITE.test(sub || "")) return { write: true, issues: [firstNumber(w.slice(3))].filter(Boolean), kind: `gh issue ${sub}` };
  if (group === "issue" && sub === "create") return { write: true, issues: [], kind: "gh issue create" };
  if (group === "pr" && PR_WRITE.test(sub || "")) {
    if (sub === "create") {
      const bodyFile = optionValue(w, "--body-file", "-F");
      const body = bodyFile ? readFile(bodyFile) : optionValue(w, "--body", "-b");
      return { write: true, issues: closesIn(body), kind: "gh pr create", head: optionValue(w, "--head", "-H"), body };
    }
    return { write: true, issues: [], pr: firstNumber(w.slice(3)), kind: `gh pr ${sub}` };
  }
  if (group === "label" && /^(create|edit|delete|clone)$/.test(sub || "")) return { write: true, issues: [], kind: `gh label ${sub}` };
  if (group === "api") {
    const rest = w.slice(2);
    const method = (optionValue(rest, "-X", "--method") || "").toUpperCase();
    const hasFields = rest.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x) || /^--(raw-)?field=/.test(x));
    const takesValue = /^(-X|--method|-f|-F|--field|--raw-field|-H|--header|-q|--jq|-t|--template|--input|--hostname|--cache)$/;
    const endpoint = rest.find((x, i) => !x.startsWith("-") && !takesValue.test(rest[i - 1] || "")) || "";
    if (endpoint === "graphql") {
      return rest.some((x) => /\bmutation\b/i.test(x)) ? { deny: "GraphQL mutations (use the gh commands the gate can check)" } : { write: false };
    }
    const write = (method && method !== "GET") || (!method && hasFields);
    if (!write) return { write: false };
    if (/\/(collaborators|branches\/[^/]+\/protection|rulesets|actions\/secrets|hooks|keys|transfer)\b|^\/?repos\/[^/]+\/[^/]+\/?$/.test(endpoint)) return { deny: `writing to ${endpoint} (repository settings or access)` };
    const issue = endpoint.match(/\/(?:issues|pulls)\/(\d+)/);
    return { write: true, issues: issue ? [Number(issue[1])] : [], kind: `gh api ${method || "POST"} ${endpoint}`, endpoint };
  }
  return { write: false };
}

// Pure decision function (deps injected so tests can run it offline).
// Returns { reason, counts } to deny, or null to allow.
function decide(input, deps) {
  const tool = input && input.tool_name;
  const args = (input && input.tool_input) || {};

  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit" || tool === "MultiEdit") {
    const p = String(args.file_path || args.notebook_path || "");
    if (PROTECTED_PATH.test(p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""))) return { reason: `editing a protected guard file (${p})`, counts: true };
    return null;
  }
  if (tool !== "Bash" && tool !== "PowerShell") return null;

  const cmd = String(args.command || "");
  if (PROTECTED.test(cmd) && WRITE_VERB.test(cmd) && !SCREEN_CMD.test(cmd)) {
    return { reason: "changing a protected guard file (settings, hooks, guard state, screening code or workflows) from the shell", counts: true };
  }

  const circuit = deps.circuit();
  for (const seg of segments(cmd)) {
    const w = words(seg);
    if (/^git$/.test(w[0]) && w.includes("push") && circuit) {
      return { reason: `circuit breaker is open since ${circuit.openedAt} after repeated blocked actions; no pushes until a human clears .claude/state/circuit-open.json`, counts: false };
    }
    if (w[0] !== "gh") continue;
    const c = classifyGh(w, deps.readFile);
    if (c.deny) return { reason: c.deny, counts: true };
    if (!c.write) continue;

    if (QUARANTINE_LABELS.test(seg) && !SCREEN_CMD.test(cmd)) {
      return { reason: `only reviewers change the ${config.quarantineLabel}/${config.clearedLabel} labels, in the GitHub UI`, counts: true };
    }
    if (circuit) {
      return { reason: `circuit breaker is open since ${circuit.openedAt} after repeated blocked actions; no GitHub writes until a human reviews .claude/state/denials.jsonl and deletes .claude/state/circuit-open.json`, counts: false };
    }

    let issues = c.issues;
    if (c.pr && c.kind === "gh pr merge") {
      try {
        issues = deps.prClosingIssues(c.pr);
      } catch (e) {
        return { reason: `could not check which issues PR #${c.pr} closes (${e.message}); failing closed`, counts: false };
      }
    }
    if (c.kind === "gh pr create" && c.head && /^ticket-/.test(c.head) && !issues.length) {
      return { reason: "a PR from a ticket branch must say which issue it closes (Closes #N) so the gate can check it", counts: false };
    }
    for (const n of issues) {
      let labels;
      try {
        labels = deps.issueLabels(n);
      } catch (e) {
        return { reason: `could not check issue #${n} labels on GitHub (${e.message}); failing closed`, counts: false };
      }
      if (labels.includes(config.quarantineLabel)) {
        return { reason: `issue #${n} is quarantined; the factory must not touch, resolve or close it`, counts: true };
      }
      if (c.kind === "gh pr merge") continue; // merging happens after human approval; quarantine is what matters here
      const s = deps.screenStatus(n);
      if (!s.ok) {
        const counts = s.verdict === "quarantine";
        return { reason: `${s.why}; run \`node scripts/screen-ticket.js ${n}\` first and only continue if it exits 0`, counts };
      }
    }
  }
  return null;
}

const liveDeps = {
  circuit: state.circuit,
  screenStatus: (n) => state.screenStatus(n),
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  },
  issueLabels: (n) =>
    JSON.parse(execFileSync("gh", ["issue", "view", String(n), "--repo", config.repo, "--json", "labels"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] })).labels.map((l) => l.name),
  prClosingIssues: (n) =>
    (JSON.parse(execFileSync("gh", ["pr", "view", String(n), "--repo", config.repo, "--json", "closingIssuesReferences"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] })).closingIssuesReferences || []).map((r) => r.number),
};

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    let verdict;
    try {
      verdict = decide(input, liveDeps);
    } catch (e) {
      verdict = { reason: `ticket gate error (${e.message}); failing closed`, counts: false };
    }
    if (!verdict) return;
    const { opened } = state.recordDenial({ hook: "ticket-gate", tool: input.tool_name, reason: verdict.reason, command: input.tool_input && (input.tool_input.command || input.tool_input.file_path), counts: verdict.counts });
    const tail = opened
      ? " Repeated blocked actions: the circuit breaker is now OPEN and all GitHub writes and pushes are halted until a human clears it. Stop and report to the user."
      : " Do not retry or work around this. Stop processing the ticket and report it.";
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Blocked by .claude/hooks/ticket-gate.js: ${verdict.reason}.${tail}` } })
    );
  });
}

module.exports = { decide, classifyGh, segments };
