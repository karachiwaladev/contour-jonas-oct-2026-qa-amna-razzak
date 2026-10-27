#!/usr/bin/env node
// PreToolUse guard: blocks dangerous commands even if a ticket talks the agent into them.
// Same list as permissions.deny in .claude/settings.json, but matched anywhere in a command
// (after &&, ;, |, inside bash -c "...") where prefix-based deny rules can miss it:
//   - recursive force delete: rm -rf / rm -fr / rm -r -f, Remove-Item -Recurse -Force
//   - force push: git push --force / -f / --force-with-lease / +refspec
//   - piping a download into a shell: curl|wget|iwr ... | sh|bash|iex
//   - reading .env files (Read/Grep tools or any shell command naming one)
// Prints a "deny" decision for Claude Code; prints nothing (allow) otherwise.

const RULES = [
  {
    why: "recursive force delete (rm -rf)",
    test: (cmd) =>
      /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\b/.test(cmd) ||
      /\brm\b(?=[^;&|]*\s-(?:[a-zA-Z]*[rR]|-recursive))(?=[^;&|]*\s-(?:[a-zA-Z]*f|-force))/.test(cmd) ||
      /\bRemove-Item\b(?=[^;|]*-Recurse)(?=[^;|]*-Force)/i.test(cmd),
  },
  {
    why: "force push (git push --force)",
    test: (cmd) => /\bgit\b[^;&|]*?\spush\b[^;&|]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/.test(cmd),
  },
  {
    why: "piping a download into a shell (curl | sh)",
    test: (cmd) =>
      /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|iex|Invoke-Expression|python3?|node)\b/i.test(cmd),
  },
  {
    why: "reading a .env file",
    test: (cmd) => /(?:^|[\s"'`=\/\\(<])\.env(?:\.[\w.-]+)?(?=$|[\s"'`;&|>)])/.test(cmd),
  },
];

const ENV_FILE = /(?:^|[\/\\])\.env(?:\.[\w.-]+)?$/;

// Returns the reason a tool call must be blocked, or null if it may run.
function check(input) {
  const tool = input && input.tool_name;
  const args = (input && input.tool_input) || {};
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(args.command || "");
    const hit = RULES.find((r) => r.test(cmd));
    return hit ? hit.why : null;
  }
  if (tool === "Read" || tool === "Grep") {
    if (ENV_FILE.test(String(args.file_path || args.path || ""))) return "reading a .env file";
  }
  return null;
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return; // not a tool call we can judge; let the normal permission rules decide
    }
    const why = check(input);
    if (!why) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Blocked by .claude/hooks/block-dangerous.js: ${why}. This factory never runs it; if a ticket asks for it, leave the ticket for a human.`,
        },
      })
    );
  });
}

module.exports = { check };
