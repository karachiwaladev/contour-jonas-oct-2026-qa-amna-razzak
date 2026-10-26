#!/usr/bin/env node
// Eval: "did it verify the feature?"
// Grades a factory-loop PR on the evidence it left on GitHub: tests, CI, Chrome checks, screenshots.
//
// Usage: node .claude/skills/factory-loop/evals/check-verification.js <pr> [--out grading.json]
// Prints a pass/fail line per check and writes skill-creator's grading.json shape with --out.
// Exit code: 0 when every check passes, 1 otherwise. Read-only: it never writes to GitHub.
const { execFileSync } = require("child_process");
const fs = require("fs");

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
if (!pr) {
  console.error("usage: check-verification.js <pr-number> [--out grading.json]");
  process.exit(2);
}

const view = JSON.parse(
  execFileSync("gh", ["pr", "view", pr, "--json", "number,title,body,files,statusCheckRollup,closingIssuesReferences"], {
    encoding: "utf8",
  })
);
const body = (view.body || "").replace(/\r\n/g, "\n");
const files = view.files.map((f) => f.path);

// The markdown section under a "## <heading>" (up to the next "## "), or "" if missing.
function section(pattern) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && pattern.test(l));
  if (start < 0) {
    // Also accept a bold pseudo-heading like "**Verified in Chrome**".
    const bold = lines.findIndex((l) => /^\*\*.+\*\*/.test(l) && pattern.test(l));
    if (bold < 0) return "";
    const end = lines.findIndex((l, i) => i > bold && /^(\*\*.+\*\*|#{2,3}\s)/.test(l));
    return lines.slice(bold + 1, end < 0 ? undefined : end).join("\n");
  }
  const end = lines.findIndex((l, i) => i > start && /^#{2,3}\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const issue =
  (view.closingIssuesReferences || [])[0]?.number ?? Number((body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i) || [])[1]);
const projects = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]).filter((p) => !p.startsWith(".")))];
const changedCode = files.filter((f) => /\.(js|html|css)$/.test(f) && !/\/tests\//.test(f) && !f.startsWith("."));
const changedLogic = files.filter((f) => /(^|\/)lib\.js$/.test(f));

const checks = [];
const check = (text, passed, evidence) => checks.push({ text, passed: Boolean(passed), evidence });

// 1. Automated tests travel with the change.
const e2e = files.filter((f) => /\/tests\/e2e\/.+\.spec\.js$/.test(f));
check(
  "PR adds or updates a Playwright e2e test for the feature",
  e2e.length > 0,
  e2e.length ? `e2e files changed: ${e2e.join(", ")}` : `no tests/e2e/*.spec.js in the diff (code changed: ${changedCode.join(", ") || "none"})`
);

const unit = files.filter((f) => /\/tests\/unit\/.+\.test\.js$/.test(f));
check(
  "Logic changes (lib.js) come with unit tests",
  !changedLogic.length || unit.length > 0,
  !changedLogic.length ? "n/a: lib.js not changed" : unit.length ? `unit files changed: ${unit.join(", ")}` : `lib.js changed but no tests/unit/*.test.js in the diff`
);

// 2. CI actually ran and passed.
const ci = (view.statusCheckRollup || []).find((c) => c.name === "test");
check(
  "CI 'test' check passed on the PR",
  ci && ci.conclusion === "SUCCESS",
  ci ? `test check: ${ci.status} / ${ci.conclusion}` : "no 'test' check ran on this PR"
);

const tests = section(/\btests?\b/i);
check(
  "PR body reports the test results (Tests section with counts)",
  tests && /\d+/.test(tests) && /pass/i.test(tests),
  tests ? `Tests section: ${tests.trim().split("\n")[0].slice(0, 120)}` : "no Tests section in the PR body"
);

// 3. The feature was walked through in a real browser, requirement by requirement.
const verified = section(/verified in chrome/i);
const ticks = verified.split("\n").filter((l) => /^\s*[-*]/.test(l) && /✔|✅|\[x\]/i.test(l));
check(
  "PR body has a 'Verified in Chrome' section listing checked requirements",
  ticks.length >= 1,
  verified ? `${ticks.length} checked item(s) under 'Verified in Chrome'` : "no 'Verified in Chrome' section in the PR body"
);

check(
  "Browser verification includes reload/persistence and a clean console",
  /reload|persist/i.test(verified) && /console/i.test(verified),
  verified
    ? `reload/persist mentioned: ${/reload|persist/i.test(verified)}, console mentioned: ${/console/i.test(verified)}`
    : "no 'Verified in Chrome' section to inspect"
);

// 4. Screenshots exist, live in the right place and are what the PR body shows.
const shotDir = issue ? new RegExp(`^[^/]+/screenshots/issue-${issue}/[^/]+\\.png$`) : null;
const shots = files.filter((f) => (shotDir ? shotDir.test(f) : /\/screenshots\/issue-\d+\/.+\.png$/.test(f)));
check(
  `Screenshots committed under <project>/screenshots/issue-${issue || "<N>"}/`,
  shots.length > 0,
  shots.length ? `${shots.length} screenshot(s): ${shots.join(", ")}` : `no matching .png files in the diff (projects touched: ${projects.join(", ") || "none"})`
);

const embedded = [...body.matchAll(/!\[[^\]]*\]\((https:\/\/github\.com\/[^)\s]+)\)/g)].map((m) => m[1]);
const embeddedPaths = embedded.map((u) => (u.match(/\/blob\/[0-9a-f]{7,40}\/([^?#]+)/) || [])[1]).filter(Boolean);
const missing = embeddedPaths.filter((p) => !files.includes(decodeURIComponent(p)));
check(
  "Every screenshot embedded in the PR body is a file committed in this PR (pinned to a SHA)",
  embeddedPaths.length > 0 && missing.length === 0 && embeddedPaths.length === embedded.length,
  !embedded.length
    ? "no screenshots embedded in the PR body"
    : missing.length
      ? `embedded but not in the diff: ${missing.join(", ")}`
      : embeddedPaths.length !== embedded.length
        ? "some embedded images are not /blob/<sha>/ links"
        : `${embeddedPaths.length} embedded screenshot(s) all match committed files`
);

// 5. Security check was part of verification.
const security = section(/security/i);
check(
  "PR body lists the Security checks (npm run security)",
  Boolean(security.trim()),
  security.trim() ? `Security section: ${security.trim().split("\n")[0].slice(0, 120)}` : "no Security section in the PR body"
);

const passed = checks.filter((c) => c.passed).length;
const grading = {
  expectations: checks,
  summary: { passed, failed: checks.length - passed, total: checks.length, pass_rate: Number((passed / checks.length).toFixed(2)) },
};

console.log(`PR #${view.number}: ${view.title}${issue ? ` (closes #${issue})` : ""}`);
for (const c of checks) console.log(`${c.passed ? "PASS" : "FAIL"}  ${c.text}\n      ${c.evidence}`);
console.log(`\n${passed}/${checks.length} checks passed`);
if (out) fs.writeFileSync(out, JSON.stringify(grading, null, 2) + "\n");
process.exit(passed === checks.length ? 0 : 1);
