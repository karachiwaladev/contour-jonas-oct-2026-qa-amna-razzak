// Shared local state for the factory's guards (git-ignored, in .claude/state/):
//   screen/<issue>.json  latest screening result, written only by scripts/screen-ticket.js
//   denials.jsonl        every action a hook blocked
//   circuit-open.json    written after repeated blocked actions; while it exists the hooks block all
//                        GitHub writes and pushes. Only a human clears it (by deleting the file).
const fs = require("fs");
const path = require("path");
const config = require("../../scripts/ticket-guard/config.json");

const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", "..");
const stateDir = () => process.env.FACTORY_GUARD_STATE || path.join(projectDir, ".claude", "state");
const file = (...p) => path.join(stateDir(), ...p);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

const readScreen = (issue) => readJson(file("screen", `${issue}.json`));
const writeScreen = (issue, record) => writeJson(file("screen", `${issue}.json`), record);

// A screening result the loop may rely on: clean, and recent enough that nobody had time to edit the ticket.
function screenStatus(issue, now = Date.now()) {
  const rec = readScreen(issue);
  if (!rec) return { ok: false, why: `issue #${issue} has not been screened` };
  if (now - Date.parse(rec.screenedAt) > config.screenTtlMinutes * 60000) return { ok: false, why: `screening of #${issue} is older than ${config.screenTtlMinutes} minutes` };
  if (rec.verdict !== "clean") return { ok: false, why: `issue #${issue} screened as ${rec.verdict}`, verdict: rec.verdict };
  return { ok: true };
}

const circuit = () => readJson(file("circuit-open.json"));

// Record a blocked action. Security denials count toward the circuit breaker: after maxDenialsBeforeHalt of
// them within the window, all GitHub writes and pushes stop until a human reviews and clears the circuit.
function recordDenial({ hook, tool, reason, command, counts = true }, now = Date.now()) {
  const entry = { at: new Date(now).toISOString(), hook, tool, reason, counts, command: String(command || "").slice(0, 300) };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(file("denials.jsonl"), JSON.stringify(entry) + "\n");
  if (!counts || circuit()) return { opened: false };
  const since = now - config.denialWindowMinutes * 60000;
  const recent = fs
    .readFileSync(file("denials.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => readJsonLine(l))
    .filter((e) => e && e.counts && Date.parse(e.at) >= since);
  if (recent.length < config.maxDenialsBeforeHalt) return { opened: false };
  writeJson(file("circuit-open.json"), { openedAt: entry.at, reasons: recent.map((e) => e.reason) });
  return { opened: true };
}

function readJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { stateDir, readScreen, writeScreen, screenStatus, circuit, recordDenial };
