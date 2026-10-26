#!/usr/bin/env node
// Stop hook: append the user prompts added since the last stop to .claude/logs/prompts.jsonl.
// Reads the hook payload (session_id, transcript_path) from stdin. Remembers how far it got
// in each session's transcript in .claude/logs/.prompt-log-state.json, so each prompt is logged once.
const fs = require("fs");
const path = require("path");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logDir = path.join(projectDir, ".claude", "logs");
const logFile = path.join(logDir, "prompts.jsonl");
const stateFile = path.join(logDir, ".prompt-log-state.json");

function promptText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((p) => p.type === "tool_result")) return null;
  const text = content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  return text || null;
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const { session_id, transcript_path } = JSON.parse(input || "{}");
  if (!session_id || !transcript_path || !fs.existsSync(transcript_path)) return;

  fs.mkdirSync(logDir, { recursive: true });
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}

  const lines = fs.readFileSync(transcript_path, "utf8").split("\n").filter(Boolean);
  let start = state[session_id] || 0;
  if (start > lines.length) start = 0; // transcript was rewritten; rescan

  const out = [];
  for (const line of lines.slice(start)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" || e.isMeta || e.isSidechain || e.toolUseResult) continue;
    // Skip system-injected turns (background task notifications etc.) and shell output echoes.
    if (e.origin && e.origin.kind !== "human") continue;
    const prompt = promptText(e.message && e.message.content);
    if (!prompt || /^<(bash-stdout|bash-stderr|local-command-)/.test(prompt)) continue;
    const source = e.scheduledTaskId ? "scheduled" : prompt.startsWith("<bash-input>") ? "shell" : "user";
    out.push(JSON.stringify({ timestamp: e.timestamp, session_id, uuid: e.uuid, source, prompt }));
  }

  if (out.length) fs.appendFileSync(logFile, out.join("\n") + "\n");
  state[session_id] = lines.length;
  fs.writeFileSync(stateFile, JSON.stringify(state));
});
